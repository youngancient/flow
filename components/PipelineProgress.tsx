"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "./Spinner";

type LogEntry = {
  stage: string;
  ok: boolean;
  error?: string;
  ts: string;
  model?: string;
  cost_usd?: number;
  [key: string]: unknown;
};

const STAGE_ORDER = ["queued", "researching", "planning_drafting", "evaluating", "revising"] as const;
const STAGE_LABEL: Record<(typeof STAGE_ORDER)[number], string> = {
  queued: "Queued",
  researching: "Researching",
  planning_drafting: "Planning & drafting",
  evaluating: "Evaluating",
  revising: "Revising",
};
const TERMINAL = new Set(["ready_for_review", "failed"]);

/**
 * Live progress view while the pipeline runs in the background (see
 * artifact/design.md, "Pipeline execution model" — createContentRequest
 * now fires runPipeline via after() and redirects immediately, so this is
 * the actual in-progress experience rather than a blocking button label).
 * Polls the same GET /api/requests/[id] the review page's data comes from;
 * once the stage reaches a terminal value, refreshes the server component
 * so the full review UI takes over.
 */
export function PipelineProgress({
  requestId,
  initialStage,
  initialLog,
  initialError,
}: {
  requestId: string;
  initialStage: string;
  initialLog: LogEntry[];
  initialError: string | null;
}) {
  const router = useRouter();
  const [stage, setStage] = useState(initialStage);
  const [log, setLog] = useState(initialLog);
  const [error, setError] = useState(initialError);
  const [elapsed, setElapsed] = useState(0);
  const pollFailures = useRef(0);

  // Elapsed-time ticker — starts at 0 on every render (server and client
  // alike), so there's nothing for hydration to diff; only client-only
  // interval ticks after mount change it.
  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (TERMINAL.has(stage)) return;

    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/requests/${requestId}`);
        const json = await res.json();
        if (!json.ok) throw new Error(json.error ?? "poll failed");
        pollFailures.current = 0;
        setStage(json.data.request.stage);
        setLog(json.data.request.pipeline_log ?? []);
        setError(json.data.request.pipeline_error ?? null);
        if (TERMINAL.has(json.data.request.stage)) {
          router.refresh();
        }
      } catch {
        // A transient network hiccup during polling isn't a pipeline
        // failure — only give up showing progress after several in a row,
        // and even then just stop polling silently rather than error out;
        // the row itself is the source of truth, visible on next refresh.
        pollFailures.current += 1;
        if (pollFailures.current >= 5) clearInterval(id);
      }
    }, 2000);

    return () => clearInterval(id);
  }, [stage, requestId, router]);

  const currentIndex = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
  const failed = stage === "failed";

  return (
    <div className="flex flex-col gap-4 border border-rule p-5">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted">
          {!failed && <Spinner />}
          {failed ? "Failed" : "Working"}
        </span>
        <span className="text-xs text-muted">{elapsed}s elapsed</span>
      </div>

      <ol className="flex flex-wrap items-center gap-x-1 gap-y-3">
        {STAGE_ORDER.map((s, i) => {
          const done = !failed && i < currentIndex;
          const active = !failed && i === currentIndex;
          const isFailurePoint = failed && i === Math.max(currentIndex, 0);
          return (
            <li key={s} className="flex items-center gap-1">
              <span
                className={[
                  "stamp",
                  done ? "text-approve" : isFailurePoint ? "text-flag" : active ? "text-pending" : "text-muted",
                  active ? "animate-pulse" : "",
                ].join(" ")}
              >
                {STAGE_LABEL[s]}
              </span>
              {i < STAGE_ORDER.length - 1 && <span className="text-muted">/</span>}
            </li>
          );
        })}
      </ol>

      {failed && error && <p className="text-sm text-flag">{error}</p>}

      {log.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-rule pt-3 text-xs">
          {[...log].reverse().map((entry, i) => (
            <li
              key={i}
              className={`flex items-center gap-2 border-l-2 pl-2 ${entry.ok ? "border-approve" : "border-flag"}`}
            >
              <span className="font-medium">{entry.stage}</span>
              <span className="text-muted">{new Date(entry.ts).toLocaleTimeString()}</span>
              {entry.error && <span className="text-flag">{entry.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
