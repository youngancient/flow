import Link from "next/link";
import { supabaseService } from "@/lib/supabase/service";
import { requireSessionEmailOrRedirect } from "@/lib/supabase/auth";
import { RequestForm } from "@/components/RequestForm";
import { StatusBadge } from "@/components/StatusBadge";
import { StatTile } from "@/components/StatTile";
import { signOut } from "@/app/actions/auth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LocalTime } from "@/components/LocalTime";
import { computePublishRollup, hasUnresolvedChannelGenerationFailure, type PublishRollup } from "@/lib/publishStatus";

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

export default async function Home() {
  await requireSessionEmailOrRedirect(); // no route is reachable by an unauthenticated request — see artifact/design.md, "Authentication"
  const db = supabaseService();

  const [{ data: requests }, { data: queueRows }] = await Promise.all([
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
  ]);

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

  // Shared between the stat tiles below and each row's badge in the past-requests
  // table, so both surfaces classify a request identically.
  function rollupFor(r: RequestRow): PublishRollup | null {
    if (r.stage !== "ready_for_review") return null;
    const hasAnyChannelOutputs = channelStatusesByRequest.has(r.id);
    if (hasUnresolvedChannelGenerationFailure(r.pipeline_log, hasAnyChannelOutputs)) return "generation_failed";
    return computePublishRollup(channelStatusesByRequest.get(r.id) ?? []);
  }

  let readyForReviewCount = 0;
  let publishedCount = 0;
  let publishFailureCount = 0;
  for (const r of requests ?? []) {
    if (r.stage !== "ready_for_review") continue;
    const rollup = rollupFor(r);
    if (rollup === "published" || rollup === "partially_published") publishedCount++;
    else if (rollup === "publish_failed" || rollup === "generation_failed") publishFailureCount++;
    else readyForReviewCount++;
  }
  const failedRequestCount = (statusCounts.get("failed") ?? 0) + publishFailureCount;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-10 px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl">Flow</h1>
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
          <div className="grid grid-cols-4 items-start gap-3">
            <StatTile label="In progress" value={String(inProgressCount)} />
            <StatTile label="Ready for review" value={String(readyForReviewCount)} />
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

        <Link href="/queue" className="self-start text-xs text-muted underline">
          View publishing queue
        </Link>
      </section>

      <section>
        <h2 className="mb-4 border-t border-rule pt-6 text-sm font-semibold text-muted">New content request</h2>
        <RequestForm />
      </section>

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
                const rollup = rollupFor(r);
                return (
                  <tr key={r.id} className="border-b border-rule">
                    <td className="py-2 pr-4">
                      <Link href={`/requests/${r.id}`} className="underline">
                        {r.raw_idea}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-muted">{r.target_audience}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={rollup ?? r.stage} />
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
