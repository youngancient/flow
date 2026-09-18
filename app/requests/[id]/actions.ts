"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireSessionEmail } from "@/lib/supabase/auth";
import { supabaseService } from "@/lib/supabase/service";
import { assertOk } from "@/lib/supabase/assert";
import { reviseDrafts } from "@/lib/claude";
import { generateChannelOutputs, regenerateSingleChannelOutput } from "@/lib/pipeline";
import { postPipelineError } from "@/lib/discord";
import { MAX_HUMAN_REVISION_ROUNDS } from "@/lib/rules";
import type { ActionResult } from "@/app/actions";

const NOT_OWNER_ERROR = "Only this request's owner can do that";

/** Embedded-resource results come back as either an object or a one-element array, depending on the relation — same unwrap used elsewhere (e.g. lib/pipeline.ts). */
function unwrapOne<T>(rel: T | T[] | null | undefined): T | null {
  if (!rel) return null;
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

async function getExcerptsByIds(ids: string[]) {
  if (ids.length === 0) return [];
  const db = supabaseService();
  const { data } = await db.from("source_chunks").select("id, chunk_text, sources(url)").in("id", ids);
  return (data ?? []).map((row: { id: string; chunk_text: string; sources: { url: string } | { url: string }[] | null }) => ({
    id: row.id,
    text: row.chunk_text,
    sourceUrl: Array.isArray(row.sources) ? row.sources[0]?.url ?? "" : row.sources?.url ?? "",
  }));
}

export async function selectDraft(requestId: string, draftId: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: draft, error: draftError } = await db
    .from("drafts")
    .select("id, request_id, content_requests!drafts_request_id_fkey(requested_by)")
    .eq("id", draftId)
    .single();
  if (draftError) {
    return { ok: false, error: `Failed to load draft: ${draftError.message}` };
  }
  if (!draft) {
    return { ok: false, error: `Draft not found: ${draftId}` };
  }
  if (draft.request_id !== requestId) {
    return { ok: false, error: `Draft ${draftId} belongs to request ${draft.request_id}, not ${requestId}` };
  }
  if (unwrapOne(draft.content_requests)?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }

  const { data: current } = await db.from("content_requests").select("selected_draft_id").eq("id", requestId).single();
  const isSwitchingDraft = Boolean(current?.selected_draft_id) && current!.selected_draft_id !== draftId;

  const { data: existingOutputs } = await db
    .from("channel_outputs")
    .select("channel, publish_status")
    .eq("request_id", requestId);
  const hasExistingOutputs = (existingOutputs?.length ?? 0) > 0;

  // Switching to a different draft once channels already exist means
  // regenerating all three from scratch (below) — refuse outright,
  // all-or-nothing, if any channel has a real external commitment that
  // can't just be silently overwritten: a sent post can never be
  // "un-sent," and a scheduled one has a live timer armed against it.
  if (isSwitchingDraft && hasExistingOutputs) {
    const sentOrSending = (existingOutputs ?? []).filter((o) => o.publish_status === "sent" || o.publish_status === "sending");
    const scheduled = (existingOutputs ?? []).filter((o) => o.publish_status === "scheduled");
    if (sentOrSending.length > 0 || scheduled.length > 0) {
      const parts: string[] = [];
      if (sentOrSending.length > 0) {
        const verb = sentOrSending.length > 1 ? "have" : "has";
        parts.push(`${sentOrSending.map((o) => o.channel).join(", ")} ${verb} already been sent`);
      }
      if (scheduled.length > 0) {
        const be = scheduled.length > 1 ? "are" : "is";
        const pronoun = scheduled.length > 1 ? "their" : "its";
        parts.push(`${scheduled.map((o) => o.channel).join(", ")} ${be} scheduled, cancel ${pronoun} schedule first`);
      }
      return { ok: false, error: `Can't switch drafts: ${parts.join("; ")}.` };
    }
  }

  try {
    await assertOk(db.from("content_requests").update({ selected_draft_id: draftId }).eq("id", requestId), "content_requests selected_draft_id update");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to select draft";
    console.error(`selectDraft: failed to set selected_draft_id for request ${requestId}:`, err);
    postPipelineError({ requestId, stage: "select_draft", error: message });
    return { ok: false, error: message };
  }

  if (!hasExistingOutputs || isSwitchingDraft) {
    try {
      await generateChannelOutputs(requestId, draftId);
    } catch (err) {
      // selected_draft_id is already committed above, and the failure is
      // now logged to pipeline_log inside generateChannelOutputs — revalidate
      // so the reviewer sees both the "selected" stamp and the failure entry
      // immediately, instead of only a toast that's easy to miss.
      revalidatePath(`/requests/${requestId}`);
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate channel outputs" };
    }
  }

  revalidatePath(`/requests/${requestId}`);
  return { ok: true };
}

export async function editDraft(
  draftId: string,
  changes: { title?: string; bodyMarkdown?: string }
): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: draft, error: draftError } = await db
    .from("drafts")
    .select("*, content_requests!drafts_request_id_fkey(requested_by)")
    .eq("id", draftId)
    .single();
  if (draftError) return { ok: false, error: `Failed to load draft: ${draftError.message}` };
  if (!draft) return { ok: false, error: "Draft not found" };
  if (unwrapOne(draft.content_requests)?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }

  try {
    await assertOk(
      db.from("drafts").insert({
        request_id: draft.request_id,
        option_label: draft.option_label,
        version: draft.version + 1,
        parent_draft_id: draft.id,
        title: changes.title ?? draft.title,
        body_markdown: changes.bodyMarkdown ?? draft.body_markdown,
        primary_keyword: draft.primary_keyword,
        secondary_keywords: draft.secondary_keywords,
        source_chunk_ids: draft.source_chunk_ids,
        revision_source: "human_edit",
        revised_by: email,
      }),
      "drafts insert (human_edit)"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save edit";
    console.error(`editDraft: failed to save human edit for draft ${draftId}:`, err);
    postPipelineError({ requestId: draft.request_id, stage: "edit_draft", error: message });
    return { ok: false, error: message };
  }

  revalidatePath(`/requests/${draft.request_id}`);
  return { ok: true };
}

export async function requestDraftRevision(draftId: string, feedback: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: draft, error: draftError } = await db
    .from("drafts")
    .select("*, content_requests!drafts_request_id_fkey(requested_by)")
    .eq("id", draftId)
    .single();
  if (draftError) return { ok: false, error: `Failed to load draft: ${draftError.message}` };
  if (!draft) return { ok: false, error: "Draft not found" };
  if (unwrapOne(draft.content_requests)?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }

  const { count } = await db
    .from("drafts")
    .select("id", { count: "exact", head: true })
    .eq("request_id", draft.request_id)
    .eq("option_label", draft.option_label)
    .eq("revision_source", "human_requested_ai");

  if ((count ?? 0) >= MAX_HUMAN_REVISION_ROUNDS) {
    return { ok: false, error: `This option has already used its ${MAX_HUMAN_REVISION_ROUNDS} human-requested revisions.` };
  }

  const excerpts = await getExcerptsByIds(draft.source_chunk_ids ?? []);

  let result;
  try {
    result = await reviseDrafts({
      items: [{ optionLabel: draft.option_label, currentTitle: draft.title, currentBody: draft.body_markdown, feedback }],
      excerpts,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Revision failed";
    console.error(`requestDraftRevision: reviseDrafts failed for draft ${draftId}:`, err);
    postPipelineError({ requestId: draft.request_id, stage: "request_draft_revision", error: message });
    return { ok: false, error: message };
  }

  const revised = result.revisions[0];
  if (!revised) return { ok: false, error: "Claude did not return a revision" };

  try {
    await assertOk(
      db.from("drafts").insert({
        request_id: draft.request_id,
        option_label: draft.option_label,
        version: draft.version + 1,
        parent_draft_id: draft.id,
        title: revised.title,
        body_markdown: revised.body_markdown,
        primary_keyword: revised.primary_keyword,
        secondary_keywords: revised.secondary_keywords,
        source_chunk_ids: revised.source_chunk_ids,
        revision_source: "human_requested_ai",
        revised_by: email,
        revision_feedback: feedback,
      }),
      "drafts insert (human_requested_ai)"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save revision";
    console.error(`requestDraftRevision: failed to save revised draft for draft ${draftId}:`, err);
    postPipelineError({ requestId: draft.request_id, stage: "save_draft_revision", error: message });
    return { ok: false, error: message };
  }

  revalidatePath(`/requests/${draft.request_id}`);
  return { ok: true };
}

export async function approveChannelOutput(channelOutputId: string, editedBody?: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("request_id, publish_status, content_requests(requested_by)")
    .eq("id", channelOutputId)
    .single();
  if (!output) return { ok: false, error: "Channel output not found" };
  if (unwrapOne(output.content_requests)?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({
          review_status: "approved",
          reviewed_by: email,
          reviewed_at: new Date().toISOString(),
          ...(editedBody ? { body: editedBody } : {}),
          publish_status: output.publish_status === "not_queued" ? "queued" : output.publish_status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", channelOutputId),
      "channel_outputs approve update"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to approve";
    console.error(`approveChannelOutput: failed to approve ${channelOutputId}:`, err);
    postPipelineError({ requestId: output.request_id, stage: "approve_channel_output", error: message });
    return { ok: false, error: message };
  }

  revalidatePath(`/requests/${output.request_id}`);
  revalidatePath("/queue");
  return { ok: true };
}

export async function rejectChannelOutput(channelOutputId: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("request_id, content_requests(requested_by)")
    .eq("id", channelOutputId)
    .single();
  if (!output) return { ok: false, error: "Channel output not found" };
  if (unwrapOne(output.content_requests)?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({ review_status: "rejected", reviewed_by: email, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", channelOutputId),
      "channel_outputs reject update"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reject";
    console.error(`rejectChannelOutput: failed to reject ${channelOutputId}:`, err);
    postPipelineError({ requestId: output.request_id, stage: "reject_channel_output", error: message });
    return { ok: false, error: message };
  }

  revalidatePath(`/requests/${output.request_id}`);
  return { ok: true };
}

/**
 * Reverts an approved-but-not-yet-published channel output back to
 * pending_review, so an approval isn't a one-way door — the reviewer can
 * change their mind before anything's actually gone out. Refuses if
 * publish_status is 'scheduled' (there's a live timer armed against it —
 * cancel that first, same reasoning as selectDraft's switch guard) or
 * 'sent'/'sending' (already happened or in flight, can never be undone).
 */
export async function unapproveChannelOutput(channelOutputId: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("request_id, review_status, publish_status, content_requests(requested_by)")
    .eq("id", channelOutputId)
    .single();
  if (!output) return { ok: false, error: "Channel output not found" };
  if (unwrapOne(output.content_requests)?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }
  if (output.review_status !== "approved") return { ok: false, error: "This isn't currently approved" };
  if (output.publish_status === "scheduled") return { ok: false, error: "Cancel its schedule first" };
  if (output.publish_status === "sent" || output.publish_status === "sending") {
    return { ok: false, error: "This has already been sent and can't be unapproved" };
  }

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({
          review_status: "pending_review",
          publish_status: "not_queued",
          reviewed_by: null,
          reviewed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", channelOutputId),
      "channel_outputs unapprove update"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to unapprove";
    console.error(`unapproveChannelOutput: failed to unapprove ${channelOutputId}:`, err);
    postPipelineError({ requestId: output.request_id, stage: "unapprove_channel_output", error: message });
    return { ok: false, error: message };
  }

  revalidatePath(`/requests/${output.request_id}`);
  revalidatePath("/queue");
  return { ok: true };
}

export async function regenerateChannelOutput(channelOutputId: string, feedback?: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("request_id, content_requests(requested_by)")
    .eq("id", channelOutputId)
    .single();
  if (!output) return { ok: false, error: "Channel output not found" };
  if (unwrapOne(output.content_requests)?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }

  try {
    await regenerateSingleChannelOutput(channelOutputId, feedback);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Regeneration failed" };
  }

  revalidatePath(`/requests/${output.request_id}`);
  return { ok: true };
}

export async function markSocialPosted(channelOutputId: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("request_id, review_status, content_requests(requested_by)")
    .eq("id", channelOutputId)
    .single();
  if (!output) return { ok: false, error: "Channel output not found" };
  if (unwrapOne(output.content_requests)?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }
  if (output.review_status !== "approved") return { ok: false, error: "Cannot publish before approval" };

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({ publish_status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", channelOutputId),
      "channel_outputs mark-posted update"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to mark posted";
    console.error(`markSocialPosted: failed to mark ${channelOutputId} posted:`, err);
    postPipelineError({ requestId: output.request_id, stage: "mark_social_posted", error: message });
    return { ok: false, error: message };
  }

  revalidatePath(`/requests/${output.request_id}`);
  revalidatePath("/queue");
  return { ok: true };
}

export async function scheduleSocialPost(channelOutputId: string, scheduledFor: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("request_id, review_status, publish_status, content_requests(requested_by)")
    .eq("id", channelOutputId)
    .single();
  if (!output) return { ok: false, error: "Channel output not found" };
  if (unwrapOne(output.content_requests)?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }
  if (output.review_status !== "approved") return { ok: false, error: "Cannot schedule before approval" };
  if (output.publish_status === "sent" || output.publish_status === "sending") {
    return { ok: false, error: "This has already been sent and can't be scheduled again" };
  }

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({ publish_status: "scheduled", scheduled_for: scheduledFor, updated_at: new Date().toISOString() })
        .eq("id", channelOutputId)
        .in("publish_status", ["not_queued", "queued", "scheduled", "failed"]),
      "channel_outputs schedule update"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to schedule";
    console.error(`scheduleSocialPost: failed to schedule ${channelOutputId}:`, err);
    postPipelineError({ requestId: output.request_id, stage: "schedule_social_post", error: message });
    return { ok: false, error: message };
  }

  revalidatePath(`/requests/${output.request_id}`);
  revalidatePath("/queue");
  return { ok: true };
}

export async function cancelScheduledSocialPost(channelOutputId: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("request_id, publish_status, content_requests(requested_by)")
    .eq("id", channelOutputId)
    .single();
  if (!output) return { ok: false, error: "Channel output not found" };
  if (unwrapOne(output.content_requests)?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }
  if (output.publish_status !== "scheduled") return { ok: false, error: "This isn't currently scheduled" };

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({ publish_status: "queued", scheduled_for: null, updated_at: new Date().toISOString() })
        .eq("id", channelOutputId),
      "channel_outputs cancel-schedule update"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to cancel schedule";
    console.error(`cancelScheduledSocialPost: failed to cancel schedule for ${channelOutputId}:`, err);
    postPipelineError({ requestId: output.request_id, stage: "cancel_scheduled_social_post", error: message });
    return { ok: false, error: message };
  }

  revalidatePath(`/requests/${output.request_id}`);
  revalidatePath("/queue");
  return { ok: true };
}

// Newsletter send/schedule/cancel are Route Handlers, not Server Actions —
// see app/api/publish/newsletter/[channelOutputId]/{send,schedule,cancel}/route.ts.
// ChannelOutputCard calls those directly via fetch().

export async function retryPipelineRun(requestId: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const { runPipeline } = await import("@/lib/pipeline");

  const db = supabaseService();

  const { data: request } = await db.from("content_requests").select("requested_by").eq("id", requestId).single();
  if (!request) return { ok: false, error: "Request not found" };
  if (request.requested_by !== email) return { ok: false, error: NOT_OWNER_ERROR };

  // Reset to a non-terminal stage *before* kicking off the background run,
  // not after — runPipeline's own first setStage() call only happens once
  // after() actually starts executing, which isn't guaranteed by the time
  // this action returns and the page revalidates. Without this, the page
  // could re-render while the row still says 'failed', showing the old
  // terminal view with nothing to indicate anything is happening — exactly
  // the "is it stuck or working" problem this fixes.
  try {
    await assertOk(
      db.from("content_requests").update({ stage: "queued", pipeline_error: null, pipeline_started_at: new Date().toISOString() }).eq("id", requestId),
      "content_requests retry stage reset"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to retry";
    console.error(`retryPipelineRun: failed to reset stage for request ${requestId}:`, err);
    postPipelineError({ requestId, stage: "retry_pipeline_run", error: message });
    return { ok: false, error: message };
  }

  after(() => runPipeline(requestId));

  revalidatePath(`/requests/${requestId}`);
  return { ok: true };
}
