"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireSessionEmail } from "@/lib/supabase/auth";
import { supabaseService } from "@/lib/supabase/service";
import { assertOk } from "@/lib/supabase/assert";
import { reviseDrafts } from "@/lib/claude";
import { generateChannelOutputs, regenerateSingleChannelOutput } from "@/lib/pipeline";
import { MAX_HUMAN_REVISION_ROUNDS } from "@/lib/rules";
import type { ActionResult } from "@/app/actions";

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
  await requireSessionEmail();
  const db = supabaseService();

  const { data: draft } = await db.from("drafts").select("id, request_id").eq("id", draftId).single();
  if (!draft || draft.request_id !== requestId) {
    return { ok: false, error: "Draft does not belong to this request" };
  }

  try {
    await assertOk(db.from("content_requests").update({ selected_draft_id: draftId }).eq("id", requestId), "content_requests selected_draft_id update");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to select draft" };
  }

  const { count } = await db
    .from("channel_outputs")
    .select("id", { count: "exact", head: true })
    .eq("request_id", requestId);

  if (!count || count === 0) {
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

  const { data: draft } = await db.from("drafts").select("*").eq("id", draftId).single();
  if (!draft) return { ok: false, error: "Draft not found" };

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
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save edit" };
  }

  revalidatePath(`/requests/${draft.request_id}`);
  return { ok: true };
}

export async function requestDraftRevision(draftId: string, feedback: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: draft } = await db.from("drafts").select("*").eq("id", draftId).single();
  if (!draft) return { ok: false, error: "Draft not found" };

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
    return { ok: false, error: err instanceof Error ? err.message : "Revision failed" };
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
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save revision" };
  }

  revalidatePath(`/requests/${draft.request_id}`);
  return { ok: true };
}

export async function approveChannelOutput(channelOutputId: string, editedBody?: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db.from("channel_outputs").select("request_id, publish_status").eq("id", channelOutputId).single();
  if (!output) return { ok: false, error: "Channel output not found" };

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
    return { ok: false, error: err instanceof Error ? err.message : "Failed to approve" };
  }

  revalidatePath(`/requests/${output.request_id}`);
  revalidatePath("/queue");
  return { ok: true };
}

export async function rejectChannelOutput(channelOutputId: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db.from("channel_outputs").select("request_id").eq("id", channelOutputId).single();
  if (!output) return { ok: false, error: "Channel output not found" };

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({ review_status: "rejected", reviewed_by: email, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", channelOutputId),
      "channel_outputs reject update"
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to reject" };
  }

  revalidatePath(`/requests/${output.request_id}`);
  return { ok: true };
}

export async function regenerateChannelOutput(channelOutputId: string, feedback?: string): Promise<ActionResult> {
  await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db.from("channel_outputs").select("request_id").eq("id", channelOutputId).single();
  if (!output) return { ok: false, error: "Channel output not found" };

  try {
    await regenerateSingleChannelOutput(channelOutputId, feedback);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Regeneration failed" };
  }

  revalidatePath(`/requests/${output.request_id}`);
  return { ok: true };
}

export async function markSocialPosted(channelOutputId: string): Promise<ActionResult> {
  await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db.from("channel_outputs").select("request_id, review_status").eq("id", channelOutputId).single();
  if (!output) return { ok: false, error: "Channel output not found" };
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
    return { ok: false, error: err instanceof Error ? err.message : "Failed to mark posted" };
  }

  revalidatePath(`/requests/${output.request_id}`);
  revalidatePath("/queue");
  return { ok: true };
}

export async function scheduleSocialPost(channelOutputId: string, scheduledFor: string): Promise<ActionResult> {
  await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db.from("channel_outputs").select("request_id, review_status").eq("id", channelOutputId).single();
  if (!output) return { ok: false, error: "Channel output not found" };
  if (output.review_status !== "approved") return { ok: false, error: "Cannot schedule before approval" };

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({ publish_status: "scheduled", scheduled_for: scheduledFor, updated_at: new Date().toISOString() })
        .eq("id", channelOutputId),
      "channel_outputs schedule update"
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to schedule" };
  }

  revalidatePath(`/requests/${output.request_id}`);
  revalidatePath("/queue");
  return { ok: true };
}

// Newsletter send/schedule are Route Handlers, not Server Actions — see
// app/api/publish/newsletter/[channelOutputId]/{send,schedule}/route.ts.
// ChannelOutputCard calls those directly via fetch().

export async function retryPipelineRun(requestId: string): Promise<ActionResult> {
  await requireSessionEmail();
  const { runPipeline } = await import("@/lib/pipeline");

  const db = supabaseService();
  // Reset to a non-terminal stage *before* kicking off the background run,
  // not after — runPipeline's own first setStage() call only happens once
  // after() actually starts executing, which isn't guaranteed by the time
  // this action returns and the page revalidates. Without this, the page
  // could re-render while the row still says 'failed', showing the old
  // terminal view with nothing to indicate anything is happening — exactly
  // the "is it stuck or working" problem this fixes.
  try {
    await assertOk(
      db.from("content_requests").update({ stage: "queued", pipeline_error: null }).eq("id", requestId),
      "content_requests retry stage reset"
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to retry" };
  }

  after(() => runPipeline(requestId));

  revalidatePath(`/requests/${requestId}`);
  return { ok: true };
}
