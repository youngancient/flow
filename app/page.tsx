import Link from "next/link";
import { supabaseService } from "@/lib/supabase/service";
import { RequestForm } from "@/components/RequestForm";
import { StatusBadge } from "@/components/StatusBadge";
import { signOut } from "@/app/actions/auth";
import { ThemeToggle } from "@/components/ThemeToggle";

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

export default async function Home() {
  const db = supabaseService();

  const [{ data: requests }, { data: queueRows }] = await Promise.all([
    db
      .from("content_requests")
      .select("id, raw_idea, target_audience, stage, created_at, pipeline_log")
      .order("created_at", { ascending: false })
      .limit(200),
    db.from("channel_outputs").select("publish_status").neq("publish_status", "not_queued"),
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
  for (const row of queueRows ?? []) {
    queueCounts.set(row.publish_status, (queueCounts.get(row.publish_status) ?? 0) + 1);
  }

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

      <section>
        <h2 className="mb-4 text-sm font-semibold text-muted">New content request</h2>
        <RequestForm />
      </section>

      <section className="flex flex-col gap-6 border-t border-rule pt-6">
        <div>
          <h2 className="mb-2 text-xs font-semibold text-muted">cost</h2>
          <p className="text-sm">
            Total spend: <strong>${totalCost.toFixed(2)}</strong>
          </p>
          {costByStage.size > 0 && (
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              {Array.from(costByStage.entries()).map(([stage, cost]) => (
                <li key={stage}>
                  {stage}: ${cost.toFixed(2)}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h2 className="mb-2 text-xs font-semibold text-muted">status</h2>
          {statusCounts.size === 0 ? (
            <p className="text-sm text-muted">No requests yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {Array.from(statusCounts.entries()).map(([stage, count]) => (
                <StatusBadge key={stage} status={stage} label={`${count} ${stage}`} />
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-2 text-xs font-semibold text-muted">publishing queue</h2>
          {queueCounts.size === 0 ? (
            <p className="text-sm text-muted">Nothing queued, scheduled, or sent yet.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {Array.from(queueCounts.entries()).map(([status, count]) => (
                <StatusBadge key={status} status={status} label={`${count} ${status}`} />
              ))}
              <Link href="/queue" className="text-xs text-muted underline">
                view queue
              </Link>
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-4 border-t border-rule pt-6 text-sm font-semibold text-muted">Past requests</h2>
        {!requests || requests.length === 0 ? (
          <p className="text-sm text-muted">No requests yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-4 border-b border-rule py-2 text-sm">
                <Link href={`/requests/${r.id}`} className="truncate underline">
                  {r.raw_idea}
                </Link>
                <span className="shrink-0 text-xs text-muted">{r.target_audience}</span>
                <StatusBadge status={r.stage} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
