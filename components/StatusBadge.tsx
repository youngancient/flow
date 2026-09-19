const TONE_MAP: Record<string, "approve" | "flag" | "pending" | "neutral"> = {
  // content_requests.stage
  queued: "pending",
  researching: "pending",
  planning_drafting: "pending",
  evaluating: "pending",
  revising: "pending",
  ready_for_review: "approve",
  failed: "flag",
  // publish/review rollup (derived — see lib/publishStatus.ts)
  published: "approve",
  partially_published: "pending",
  publish_failed: "flag",
  generation_failed: "flag",
  awaiting_review: "pending",
  needs_changes: "flag",
  // evaluations.overall_status
  pass: "approve",
  revise: "pending",
  reject: "flag",
  // channel_outputs.review_status
  draft: "neutral",
  pending_review: "pending",
  approved: "approve",
  changes_requested: "pending",
  rejected: "flag",
  // channel_outputs.publish_status ("queued" shares content_requests.stage's entry above)
  not_queued: "neutral",
  scheduled: "pending",
  sending: "pending",
  sent: "approve",
};

const TONE_CLASS: Record<string, string> = {
  approve: "text-approve",
  flag: "text-flag",
  pending: "text-pending",
  neutral: "text-muted",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = TONE_MAP[status] ?? "neutral";
  return (
    <span className={`stamp ${TONE_CLASS[tone]}`}>
      {(label ?? status).replace(/_/g, " ")}
    </span>
  );
}
