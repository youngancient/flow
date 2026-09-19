import Link from "next/link";
import { supabaseService } from "@/lib/supabase/service";
import { requireSessionEmailOrRedirect, isManager } from "@/lib/supabase/auth";
import { RequestForm } from "@/components/RequestForm";
import { StatusBadge } from "@/components/StatusBadge";
import { StatTile } from "@/components/StatTile";
import { signOut } from "@/app/actions/auth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LocalTime } from "@/components/LocalTime";
import { computePublishRollup, computeReviewRollup, describeChannelStatus, hasUnresolvedChannelGenerationFailure, type PublishRollup } from "@/lib/publishStatus";

export const maxDuration = 300; // hosts the createContentRequest Server Action — see artifact/design.md
export const dynamic = "force-dynamic"; // always-fresh dashboard state, never statically cached

type LogEntry = {
  stage: string;
  ok: boolean;
  error?: string;
  ts: string;
  model?: string;
  cost_usd?: number;
};

type RequestRow = {
  id: string;
  raw_idea: string;
  target_audience: string;
  stage: string;
  created_at: string;
  pipeline_log: unknown;
};

type ReviewRow = {
  id: string;
  request_id: string;
  channel: string;
  review_status: string;
  updated_at: string;
  content_requests: { raw_idea: string; requested_by: string } | { raw_idea: string; requested_by: string }[] | null;
};

export default async function Home() {
  const sessionEmail = await requireSessionEmailOrRedirect(); // no route is reachable by an unauthenticated request — see artifact/design.md, "Authentication"
  const viewerIsManager = await isManager();
  const db = supabaseService();

  const [{ data: requests }, { data: queueRows }, { data: reviewRowsRaw }] = await Promise.all([
    db
      .from("content_requests")
      .select("id, raw_idea, target_audience, stage, created_at, pipeline_log")
      .order("created_at", { ascending: false })
      .limit(200),
    // Unfiltered (includes not_queued) — computePublishRollup already ignores
    // not_queued rows itself, and having every row here lets
    // channelStatusesByRequest.has(id) double as "does this request have any
    // channel_outputs at all," which the generation-failure check needs.
    db.from("channel_outputs").select("request_id, publish_status"),
    // Needs-your-review list — only ever rendered for managers, but fetched
    // unconditionally since this table is small.
    db.from("channel_outputs").select("id, request_id, channel, review_status, updated_at, content_requests(raw_idea, requested_by)"),
  ]);
  const reviewRows = (reviewRowsRaw ?? []) as ReviewRow[];
  const needsReview = reviewRows.filter((row) => {
    const request = Array.isArray(row.content_requests) ? row.content_requests[0] : row.content_requests;
    // A manager can't act on their own submission even with the role, so it never counts toward their queue.
    return row.review_status === "pending_review" && request && request.requested_by !== sessionEmail;
  });
  // Grouped by request — a "send for approval" submits all three channels
  // at once, so it should read as one thing waiting on the manager, not
  // three, even though each channel is still approved/rejected separately
  // once they open the request.
  type NeedsReviewRow = { requestId: string; rawIdea: string; requestedBy: string; channels: string[]; earliestUpdatedAt: string };
  const needsReviewByRequest = new Map<string, NeedsReviewRow>();
  for (const row of needsReview) {
    const request = Array.isArray(row.content_requests) ? row.content_requests[0] : row.content_requests;
    if (!request) continue;
    const existing = needsReviewByRequest.get(row.request_id);
    if (existing) {
      existing.channels.push(row.channel);
      if (row.updated_at < existing.earliestUpdatedAt) existing.earliestUpdatedAt = row.updated_at;
    } else {
      needsReviewByRequest.set(row.request_id, {
        requestId: row.request_id,
        rawIdea: request.raw_idea,
        requestedBy: request.requested_by,
        channels: [row.channel],
        earliestUpdatedAt: row.updated_at,
      });
    }
  }
  const needsReviewRows = Array.from(needsReviewByRequest.values());
  const reviewStatusesByRequest = new Map<string, string[]>();
  for (const row of reviewRows) {
    const arr = reviewStatusesByRequest.get(row.request_id) ?? [];
    arr.push(row.review_status);
    reviewStatusesByRequest.set(row.request_id, arr);
  }

  // Cost totals come from the same append-only pipeline_log column — see
  // artifact/design.md, "Cost Awareness."
  let totalCost = 0;
  const costByStage = new Map<string, number>();
  const statusCounts = new Map<string, number>();

  for (const r of requests ?? []) {
    statusCounts.set(r.stage, (statusCounts.get(r.stage) ?? 0) + 1);
    const log = (Array.isArray(r.pipeline_log) ? r.pipeline_log : []) as LogEntry[];
    for (const entry of log) {
      if (typeof entry.cost_usd === "number") {
        totalCost += entry.cost_usd;
        costByStage.set(entry.stage, (costByStage.get(entry.stage) ?? 0) + entry.cost_usd);
      }
    }
  }

  const queueCounts = new Map<string, number>();
  const channelStatusesByRequest = new Map<string, string[]>();
  for (const row of queueRows ?? []) {
    queueCounts.set(row.publish_status, (queueCounts.get(row.publish_status) ?? 0) + 1);
    const arr = channelStatusesByRequest.get(row.request_id) ?? [];
    arr.push(row.publish_status);
    channelStatusesByRequest.set(row.request_id, arr);
  }

  const NON_TERMINAL_STAGES = ["queued", "researching", "planning_drafting", "evaluating", "revising"];
  const inProgressCount = NON_TERMINAL_STAGES.reduce((sum, s) => sum + (statusCounts.get(s) ?? 0), 0);
  const scheduledCount = queueCounts.get("scheduled") ?? 0;
  const sentCount = queueCounts.get("sent") ?? 0;

  // Feeds the stat tiles below — each request needs to land in exactly one
  // bucket to count, so this stays a single flat value. Falls back from
  // publish-status (has a channel actually been approved/sent/failed?) to
  // review-status (has a channel at least been submitted/bounced back?) to
  // the plain pipeline stage, in that order of specificity.
  function rollupFor(r: RequestRow): PublishRollup | "awaiting_review" | "needs_changes" | null {
    if (r.stage !== "ready_for_review") return null;
    const hasAnyChannelOutputs = channelStatusesByRequest.has(r.id);
    if (hasUnresolvedChannelGenerationFailure(r.pipeline_log, hasAnyChannelOutputs)) return "generation_failed";
    const publishRollup = computePublishRollup(channelStatusesByRequest.get(r.id) ?? []);
    if (publishRollup) return publishRollup;
    return computeReviewRollup(reviewStatusesByRequest.get(r.id) ?? []);
  }

  // The past-requests table's badge, unlike the stat tiles, can afford to
  // show a mixed outcome (e.g. "approved, 2 need changes") instead of
  // collapsing it to one bucket — same generation-failure priority as
  // rollupFor, just a richer label underneath it.
  function statusSummaryFor(r: RequestRow): { status: string; label: string } {
    if (r.stage !== "ready_for_review") return { status: r.stage, label: r.stage };
    const hasAnyChannelOutputs = channelStatusesByRequest.has(r.id);
    if (hasUnresolvedChannelGenerationFailure(r.pipeline_log, hasAnyChannelOutputs)) {
      return { status: "generation_failed", label: "generation_failed" };
    }
    const summary = describeChannelStatus(channelStatusesByRequest.get(r.id) ?? [], reviewStatusesByRequest.get(r.id) ?? []);
    return summary ?? { status: r.stage, label: r.stage };
  }

  let readyForReviewCount = 0;
  let awaitingReviewCount = 0;
  let needsChangesCount = 0;
  let publishedCount = 0;
  let publishFailureCount = 0;
  for (const r of requests ?? []) {
    if (r.stage !== "ready_for_review") continue;
    const rollup = rollupFor(r);
    // "approved" (cleared for publishing, nothing sent yet) counts as
    // Published here for a simple aggregate count — the per-request badge
    // still shows the finer distinction.
    if (rollup === "published" || rollup === "partially_published" || rollup === "approved") publishedCount++;
    else if (rollup === "publish_failed" || rollup === "generation_failed") publishFailureCount++;
    else if (rollup === "needs_changes") needsChangesCount++;
    else if (rollup === "awaiting_review") awaitingReviewCount++;
    else readyForReviewCount++;
  }
  const failedRequestCount = (statusCounts.get("failed") ?? 0) + publishFailureCount;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-10 px-6 py-12">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="font-serif text-2xl">Flow</h1>
          {viewerIsManager && <span className="stamp text-muted">Manager</span>}
        </div>
        <div className="flex items-center gap-4">
          <ThemeToggle />
          <Link href="/queue" className="text-sm text-muted underline">
            Publishing queue
          </Link>
          <form action={signOut}>
            <button type="submit" className="cursor-pointer text-sm text-muted underline">
              Log out
            </button>
          </form>
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <StatTile label="Total spend" value={`$${totalCost.toFixed(2)}`}>
          {costByStage.size > 0 && (
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              {Array.from(costByStage.entries()).map(([stage, cost]) => (
                <li key={stage}>
                  {stage}: ${cost.toFixed(2)}
                </li>
              ))}
            </ul>
          )}
        </StatTile>
        <div>
          <h3 className="mb-2 text-xs font-semibold text-muted">requests</h3>
          <div className="grid grid-cols-3 items-start gap-3">
            <StatTile label="In progress" value={String(inProgressCount)} />
            <StatTile label="Ready for review" value={String(readyForReviewCount)} />
            <StatTile label="Awaiting review" value={String(awaitingReviewCount)} />
            <StatTile label="Needs changes" value={String(needsChangesCount)} />
            <StatTile label="Published" value={String(publishedCount)} />
            <StatTile label="Failed" value={String(failedRequestCount)} />
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold text-muted">channels</h3>
          <div className="grid grid-cols-2 items-start gap-3">
            <StatTile label="Scheduled" value={String(scheduledCount)} />
            <StatTile label="Sent" value={String(sentCount)} />
          </div>
        </div>

        {viewerIsManager && (
          <div>
            <h3 className="mb-2 text-xs font-semibold text-muted">needs your review</h3>
            {needsReviewRows.length === 0 ? (
              <p className="text-sm text-muted">Nothing waiting on you.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-rule text-xs text-muted">
                    <th className="py-2 pr-4 font-medium">Idea</th>
                    <th className="py-2 pr-4 font-medium">Channels</th>
                    <th className="py-2 pr-4 font-medium">Requester</th>
                    <th className="py-2 font-medium">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {needsReviewRows.map((row) => (
                    <tr key={row.requestId} className="border-b border-rule">
                      <td className="py-2 pr-4">
                        <Link href={`/requests/${row.requestId}`} className="underline">
                          {row.rawIdea}
                        </Link>
                      </td>
                      <td className="py-2 pr-4 capitalize">{row.channels.join(", ")}</td>
                      <td className="py-2 pr-4 text-muted">{row.requestedBy}</td>
                      <td className="py-2 text-xs text-muted">
                        <LocalTime iso={row.earliestUpdatedAt} withTime />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      {!viewerIsManager && (
        <section>
          <h2 className="mb-4 border-t border-rule pt-6 text-sm font-semibold text-muted">New content request</h2>
          <RequestForm />
        </section>
      )}

      <section>
        <h2 className="mb-4 border-t border-rule pt-6 text-sm font-semibold text-muted">Past requests</h2>
        {!requests || requests.length === 0 ? (
          <p className="text-sm text-muted">No requests yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-rule text-xs text-muted">
                <th className="py-2 pr-4 font-medium">Idea</th>
                <th className="py-2 pr-4 font-medium">Audience</th>
                <th className="py-2 pr-4 font-medium">Stage</th>
                <th className="py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => {
                const summary = statusSummaryFor(r);
                return (
                  <tr key={r.id} className="border-b border-rule">
                    <td className="py-2 pr-4">
                      <Link href={`/requests/${r.id}`} className="underline">
                        {r.raw_idea}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-muted">{r.target_audience}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={summary.status} label={summary.label} />
                    </td>
                    <td className="py-2 text-xs text-muted">
                      <LocalTime iso={r.created_at} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
