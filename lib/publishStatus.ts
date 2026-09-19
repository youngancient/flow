export type PublishRollup = "approved" | "published" | "partially_published" | "publish_failed" | "generation_failed";

/** Derives a request-level publish rollup from its channel_outputs.publish_status
 *  values. Returns null when nothing has been queued yet, so callers fall back
 *  to content_requests.stage (or, one level further, computeReviewRollup). */
export function computePublishRollup(publishStatuses: string[]): Exclude<PublishRollup, "generation_failed"> | null {
  const queued = publishStatuses.filter((s) => s !== "not_queued");
  if (queued.length === 0) return null;
  if (queued.every((s) => s === "sent")) return "published";
  const stillInFlight = queued.some((s) => s === "queued" || s === "scheduled" || s === "sending");
  if (!stillInFlight && queued.some((s) => s === "failed")) return "publish_failed";
  // Everything's approved and queued/scheduled, but nothing has actually
  // gone out (or failed to) yet — distinct from "partially_published",
  // which means some real send has already happened or been attempted.
  if (stillInFlight && !queued.some((s) => s === "sent" || s === "failed")) return "approved";
  return "partially_published";
}

/**
 * Derives a coarser request-level rollup from review_status alone, for when
 * computePublishRollup has nothing to report (no channel has been approved
 * yet, so publish_status is still 'not_queued' across the board). Without
 * this, 'pending_review', 'rejected', and 'changes_requested' are
 * indistinguishable from a request that hasn't even had a draft selected
 * yet — all of them just fall back to the generic 'ready_for_review' stage.
 * Needs-changes outranks awaiting-review when a request's three channels
 * are in mixed states, since it's the one that actually needs the owner's
 * attention; a request with nothing but 'draft' channels (or none at all)
 * returns null, meaning "ready_for_review" is still the accurate label.
 */
export function computeReviewRollup(reviewStatuses: string[]): "awaiting_review" | "needs_changes" | null {
  if (reviewStatuses.some((s) => s === "rejected" || s === "changes_requested")) return "needs_changes";
  if (reviewStatuses.some((s) => s === "pending_review")) return "awaiting_review";
  return null;
}

export type ChannelStatusSummary = { status: string; label: string };

/**
 * Combines the publish and review rollups into one badge-ready summary
 * that can represent a mixed outcome across a request's channels — e.g.
 * one channel approved while another got bounced back — instead of a flat
 * headline silently hiding that (computePublishRollup returning "approved"
 * the moment even one channel is approved, regardless of what the other
 * two are doing). `status` drives the badge's tone (an actionable issue —
 * needs_changes, then awaiting_review — outranks a positive headline for
 * tone purposes, since that's what the viewer actually needs to notice);
 * `label` is the full display text. Returns null when there's nothing to
 * report, same as the two rollups it composes, so callers fall back to the
 * plain stage.
 */
export function describeChannelStatus(publishStatuses: string[], reviewStatuses: string[]): ChannelStatusSummary | null {
  const headline = computePublishRollup(publishStatuses) ?? computeReviewRollup(reviewStatuses);
  if (!headline) return null;

  const needsChangesCount = reviewStatuses.filter((s) => s === "rejected" || s === "changes_requested").length;
  const awaitingCount = reviewStatuses.filter((s) => s === "pending_review").length;

  const parts: string[] = [];
  if (headline !== "needs_changes" && needsChangesCount > 0) {
    parts.push(`${needsChangesCount} need${needsChangesCount === 1 ? "s" : ""} changes`);
  }
  if (headline !== "awaiting_review" && awaitingCount > 0) {
    parts.push(`${awaitingCount} awaiting review`);
  }

  const headlineText = headline.replace(/_/g, " ");
  const label = parts.length > 0 ? `${headlineText}, ${parts.join(", ")}` : headlineText;
  const status = needsChangesCount > 0 ? "needs_changes" : awaitingCount > 0 ? "awaiting_review" : headline;
  return { status, label };
}

/**
 * Whether switching the selected draft (selectDraft, app/requests/[id]/actions.ts)
 * is allowed given the current channel outputs, and why not if it isn't.
 * Switching regenerates all three channels from scratch, so it's blocked
 * once a channel is out of the owner's hands: submitted and awaiting a
 * manager's decision ('pending_review'), or already approved (which, if
 * scheduled or sent, has an even more specific reason below) — a manager's
 * decision shouldn't be silently discarded by the owner switching under it.
 * 'draft' (not yet submitted), 'rejected', and 'changes_requested' (the
 * manager already bounced it back, so a different angle is a legitimate
 * next move) are all switchable. Returns null when switching is fine.
 */
export function describeSwitchDraftBlock(
  outputs: Array<{ channel: string; review_status: string; publish_status: string }>
): string | null {
  const sentOrSending = outputs.filter((o) => o.publish_status === "sent" || o.publish_status === "sending");
  const scheduled = outputs.filter((o) => o.publish_status === "scheduled");
  const approvedNotYetLive = outputs.filter(
    (o) => o.review_status === "approved" && o.publish_status !== "sent" && o.publish_status !== "sending" && o.publish_status !== "scheduled"
  );
  const pendingReview = outputs.filter((o) => o.review_status === "pending_review");

  if (sentOrSending.length === 0 && scheduled.length === 0 && approvedNotYetLive.length === 0 && pendingReview.length === 0) {
    return null;
  }

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
  if (approvedNotYetLive.length > 0) {
    const be = approvedNotYetLive.length > 1 ? "are" : "is";
    parts.push(`${approvedNotYetLive.map((o) => o.channel).join(", ")} ${be} already approved, ask your manager to unapprove and reject or request changes first`);
  }
  if (pendingReview.length > 0) {
    const be = pendingReview.length > 1 ? "are" : "is";
    parts.push(`${pendingReview.map((o) => o.channel).join(", ")} ${be} awaiting manager review`);
  }
  return `Can't switch drafts: ${parts.join("; ")}.`;
}

/**
 * True when generateChannelOutputs threw (logged a `channel_adaptation`
 * failure to pipeline_log) and channel generation has never since succeeded
 * for this request — i.e. no channel_outputs rows exist at all. If channel
 * generation succeeded on a later retry/draft switch, channel_outputs rows
 * exist and this returns false even though a stale failure entry is still
 * sitting in the log from the earlier attempt.
 */
export function hasUnresolvedChannelGenerationFailure(pipelineLog: unknown, hasAnyChannelOutputs: boolean): boolean {
  if (hasAnyChannelOutputs || !Array.isArray(pipelineLog)) return false;
  return pipelineLog.some(
    (entry) => entry && typeof entry === "object" && (entry as { stage?: unknown }).stage === "channel_adaptation" && (entry as { ok?: unknown }).ok === false
  );
}
