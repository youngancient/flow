"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireSessionEmail, isManager } from "@/lib/supabase/auth";
import { supabaseService } from "@/lib/supabase/service";
import { assertOk } from "@/lib/supabase/assert";
import { reviseDrafts } from "@/lib/claude";
import { generateChannelOutputs, regenerateSingleChannelOutput } from "@/lib/pipeline";
import { notifyManagerForReview, notifyReviewDecision } from "@/lib/notify";
import { postPipelineError } from "@/lib/discord";
import { describeSwitchDraftBlock } from "@/lib/publishStatus";
import { MAX_HUMAN_REVISION_ROUNDS, X_CHAR_LIMIT, xPostCharCount } from "@/lib/rules";
import type { ActionResult } from "@/app/actions";

const NOT_OWNER_ERROR = "Only this request's owner can do that";
const NOT_MANAGER_ERROR = "Only a manager can do that";
const OWN_REQUEST_ERROR = "You can't review your own request";
const DRAFT_LOCKED_ERROR = "Can't edit this option while its channels are awaiting manager review or already approved";

/**
 * Editing/revising a draft is only locked when it's the one actually
 * backing channels that are out of the owner's hands — the same condition
 * selectDraft's switch-guard uses (describeSwitchDraftBlock). A non-selected
 * option, or a selected one whose channels are still 'draft'/'rejected'/
 * 'changes_requested', stays freely editable.
 */
async function assertDraftNotLockedByReview(
  db: ReturnType<typeof supabaseService>,
  requestId: string,
  draftId: string,
  selectedDraftId: string | null
): Promise<string | null> {
  if (selectedDraftId !== draftId) return null;
  const { data: outputs } = await db.from("channel_outputs").select("channel, review_status, publish_status").eq("request_id", requestId);
  if (!outputs || outputs.length === 0) return null;
  return describeSwitchDraftBlock(outputs) ? DRAFT_LOCKED_ERROR : null;
}

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
    .select("channel, review_status, publish_status")
    .eq("request_id", requestId);
  const hasExistingOutputs = (existingOutputs?.length ?? 0) > 0;

  // Switching to a different draft once channels already exist means
  // regenerating all three from scratch (below) — refuse outright,
  // all-or-nothing, once a channel is out of the owner's hands (submitted,
  // approved, scheduled, or sent). See describeSwitchDraftBlock for the
  // exact rules.
  if (isSwitchingDraft && hasExistingOutputs) {
    const blockReason = describeSwitchDraftBlock(existingOutputs ?? []);
    if (blockReason) {
      return { ok: false, error: blockReason };
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

/**
 * Owner-only: moves all three channel outputs from 'draft' (generated, not
 * yet reviewable) to 'pending_review' at once, and notifies every manager.
 * Channels are always generated together (generateChannelOutputs), so they
 * should always share the same pre-submission state — refusing when any of
 * them isn't 'draft' catches a double-submit or a stale click rather than
 * silently re-notifying managers about something already in their queue.
 */
export async function sendForApproval(requestId: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: request } = await db.from("content_requests").select("requested_by").eq("id", requestId).single();
  if (!request) return { ok: false, error: "Request not found" };
  if (request.requested_by !== email) return { ok: false, error: NOT_OWNER_ERROR };

  const { data: outputs } = await db.from("channel_outputs").select("id, review_status").eq("request_id", requestId);
  if (!outputs || outputs.length === 0) return { ok: false, error: "No channel outputs to send for approval" };
  if (outputs.some((o) => o.review_status !== "draft")) {
    return { ok: false, error: "Already sent for approval" };
  }

  try {
    await assertOk(
      db.from("channel_outputs").update({ review_status: "pending_review", updated_at: new Date().toISOString() }).eq("request_id", requestId),
      "channel_outputs send-for-approval update"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send for approval";
    console.error(`sendForApproval: failed for request ${requestId}:`, err);
    postPipelineError({ requestId, stage: "send_for_approval", error: message });
    return { ok: false, error: message };
  }

  await notifyManagerForReview(requestId);

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
    .select("*, content_requests!drafts_request_id_fkey(requested_by, selected_draft_id)")
    .eq("id", draftId)
    .single();
  if (draftError) return { ok: false, error: `Failed to load draft: ${draftError.message}` };
  if (!draft) return { ok: false, error: "Draft not found" };
  const request = unwrapOne(draft.content_requests);
  if (request?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }
  const lockedError = await assertDraftNotLockedByReview(db, draft.request_id, draftId, request.selected_draft_id);
  if (lockedError) return { ok: false, error: lockedError };

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
    .select("*, content_requests!drafts_request_id_fkey(requested_by, selected_draft_id)")
    .eq("id", draftId)
    .single();
  if (draftError) return { ok: false, error: `Failed to load draft: ${draftError.message}` };
  if (!draft) return { ok: false, error: "Draft not found" };
  const request = unwrapOne(draft.content_requests);
  if (request?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }
  const lockedError = await assertDraftNotLockedByReview(db, draft.request_id, draftId, request.selected_draft_id);
  if (lockedError) return { ok: false, error: lockedError };

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

export async function approveChannelOutput(channelOutputId: string): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("request_id, publish_status, content_requests(requested_by)")
    .eq("id", channelOutputId)
    .single();
  if (!output) return { ok: false, error: "Channel output not found" };
  if (!(await isManager())) return { ok: false, error: NOT_MANAGER_ERROR };
  if (unwrapOne(output.content_requests)?.requested_by === email) return { ok: false, error: OWN_REQUEST_ERROR };

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({
          review_status: "approved",
          review_comment: null,
          reviewed_by: email,
          reviewed_at: new Date().toISOString(),
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

  await notifyReviewDecision(channelOutputId, "approved", email);
  revalidatePath(`/requests/${output.request_id}`);
  revalidatePath("/queue");
  revalidatePath("/");
  return { ok: true };
}

export async function rejectChannelOutput(channelOutputId: string, note: string): Promise<ActionResult> {
  if (!note.trim()) return { ok: false, error: "A note is required to reject" };
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("request_id, content_requests(requested_by)")
    .eq("id", channelOutputId)
    .single();
  if (!output) return { ok: false, error: "Channel output not found" };
  if (!(await isManager())) return { ok: false, error: NOT_MANAGER_ERROR };
  if (unwrapOne(output.content_requests)?.requested_by === email) return { ok: false, error: OWN_REQUEST_ERROR };

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({
          review_status: "rejected",
          review_comment: note.trim(),
          reviewed_by: email,
          reviewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", channelOutputId),
      "channel_outputs reject update"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reject";
    console.error(`rejectChannelOutput: failed to reject ${channelOutputId}:`, err);
    postPipelineError({ requestId: output.request_id, stage: "reject_channel_output", error: message });
    return { ok: false, error: message };
  }

  await notifyReviewDecision(channelOutputId, "rejected", email);
  revalidatePath(`/requests/${output.request_id}`);
  revalidatePath("/");
  return { ok: true };
}

/**
 * Bounces a channel output back to the requester with guidance instead of
 * an outright rejection. Same next step as reject (the requester edits or
 * regenerates and resubmits) — the distinct status only exists so the
 * history/dashboard can show why it came back, not to change the mechanics.
 */
export async function requestChannelOutputChanges(channelOutputId: string, comment: string): Promise<ActionResult> {
  if (!comment.trim()) return { ok: false, error: "A comment is required to request changes" };
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("request_id, content_requests(requested_by)")
    .eq("id", channelOutputId)
    .single();
  if (!output) return { ok: false, error: "Channel output not found" };
  if (!(await isManager())) return { ok: false, error: NOT_MANAGER_ERROR };
  if (unwrapOne(output.content_requests)?.requested_by === email) return { ok: false, error: OWN_REQUEST_ERROR };

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({
          review_status: "changes_requested",
          review_comment: comment.trim(),
          reviewed_by: email,
          reviewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", channelOutputId),
      "channel_outputs request-changes update"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to request changes";
    console.error(`requestChannelOutputChanges: failed for ${channelOutputId}:`, err);
    postPipelineError({ requestId: output.request_id, stage: "request_channel_output_changes", error: message });
    return { ok: false, error: message };
  }

  await notifyReviewDecision(channelOutputId, "changes_requested", email);
  revalidatePath(`/requests/${output.request_id}`);
  revalidatePath("/");
  return { ok: true };
}

/**
 * Reverts an approved-but-not-yet-published channel output back to
 * pending_review, so an approval isn't a one-way door — a manager can
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
  if (!(await isManager())) return { ok: false, error: NOT_MANAGER_ERROR };
  if (unwrapOne(output.content_requests)?.requested_by === email) return { ok: false, error: OWN_REQUEST_ERROR };
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

  await notifyReviewDecision(channelOutputId, "unapproved", email);
  revalidatePath(`/requests/${output.request_id}`);
  revalidatePath("/queue");
  return { ok: true };
}

export async function regenerateChannelOutput(channelOutputId: string, feedback?: string): Promise<ActionResult> {
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
  if (output.review_status === "approved" || output.review_status === "pending_review") {
    return { ok: false, error: "Can't regenerate this while it's awaiting manager review or already approved" };
  }

  try {
    await regenerateSingleChannelOutput(channelOutputId, feedback);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Regeneration failed" };
  }

  revalidatePath(`/requests/${output.request_id}`);
  return { ok: true };
}

/**
 * Owner-only manual edit — the counterpart to regenerateChannelOutput for
 * when the requester wants to hand-fix the text instead of asking the AI
 * to. Body edits used to only ever persist via approveChannelOutput, which
 * owners can no longer call now that approval is manager-only; this is the
 * only other place a body/subject change gets saved. Only 'draft' (not yet
 * sent) and 'rejected'/'changes_requested' (bounced back) are editable —
 * once it's 'pending_review' it's out of the owner's hands until a manager
 * decides, and 'approved' means a decision already happened. Never changes
 * review_status by itself — see resubmitChannelOutput for the explicit
 * step that sends a bounced-back edit back to a manager, so the owner can
 * make several passes without pinging managers on every save.
 */
export async function saveChannelOutputEdit(
  channelOutputId: string,
  changes: { body: string; subject?: string; hashtags?: string[] }
): Promise<ActionResult> {
  const email = await requireSessionEmail();
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("request_id, channel, review_status, content_requests(requested_by)")
    .eq("id", channelOutputId)
    .single();
  if (!output) return { ok: false, error: "Channel output not found" };
  if (unwrapOne(output.content_requests)?.requested_by !== email) {
    return { ok: false, error: NOT_OWNER_ERROR };
  }
  if (output.review_status === "approved" || output.review_status === "pending_review") {
    return { ok: false, error: "Can't edit this while it's awaiting manager review or already approved" };
  }
  if (changes.hashtags && output.channel === "x") {
    if (changes.hashtags.length > 2) return { ok: false, error: "Use at most 2 hashtags" };
    const length = xPostCharCount(changes.body, changes.hashtags);
    if (length > X_CHAR_LIMIT) return { ok: false, error: `That's ${length} characters with hashtags; the limit is ${X_CHAR_LIMIT}` };
  }

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({
          body: changes.body,
          ...(changes.subject !== undefined ? { subject: changes.subject } : {}),
          ...(changes.hashtags !== undefined ? { hashtags: changes.hashtags } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", channelOutputId),
      "channel_outputs save-edit update"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save edit";
    console.error(`saveChannelOutputEdit: failed for ${channelOutputId}:`, err);
    postPipelineError({ requestId: output.request_id, stage: "save_channel_output_edit", error: message });
    return { ok: false, error: message };
  }

  revalidatePath(`/requests/${output.request_id}`);
  return { ok: true };
}

/**
 * Owner-only: the explicit step that sends a bounced-back channel
 * ('rejected'/'changes_requested') back to a manager — clears the
 * manager's old comment/attribution, flips to 'pending_review', and
 * re-notifies every manager. Separate from saveChannelOutputEdit/
 * regenerateChannelOutput on purpose: editing or regenerating no longer
 * auto-resubmits, so the owner can take several passes at the content
 * before actually sending it back, instead of every save re-pinging
 * managers about a still-in-progress fix.
 */
export async function resubmitChannelOutput(channelOutputId: string): Promise<ActionResult> {
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
  if (output.review_status !== "rejected" && output.review_status !== "changes_requested") {
    return { ok: false, error: "This isn't currently rejected or awaiting changes" };
  }

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({
          review_status: "pending_review",
          review_comment: null,
          reviewed_by: null,
          reviewed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", channelOutputId),
      "channel_outputs resubmit update"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to resubmit";
    console.error(`resubmitChannelOutput: failed for ${channelOutputId}:`, err);
    postPipelineError({ requestId: output.request_id, stage: "resubmit_channel_output", error: message });
    return { ok: false, error: message };
  }

  await notifyManagerForReview(output.request_id);
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
