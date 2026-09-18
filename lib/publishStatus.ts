export type PublishRollup = "published" | "partially_published" | "publish_failed" | "generation_failed";

/** Derives a request-level publish rollup from its channel_outputs.publish_status
 *  values. Returns null when nothing has been queued yet, so callers fall back
 *  to content_requests.stage unchanged. */
export function computePublishRollup(publishStatuses: string[]): Exclude<PublishRollup, "generation_failed"> | null {
  const queued = publishStatuses.filter((s) => s !== "not_queued");
  if (queued.length === 0) return null;
  if (queued.every((s) => s === "sent")) return "published";
  const stillInFlight = queued.some((s) => s === "queued" || s === "scheduled" || s === "sending");
  if (!stillInFlight && queued.some((s) => s === "failed")) return "publish_failed";
  return "partially_published";
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
