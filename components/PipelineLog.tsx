"use client";

import { useState } from "react";

type LogEntry = {
  stage: string;
  ok: boolean;
  error?: string;
  ts: string;
  model?: string;
  tokens?: { input: number; output: number };
  cost_usd?: number;
  [key: string]: unknown;
};

export function PipelineLog({ log }: { log: LogEntry[] }) {
  const [open, setOpen] = useState(false);

  const totalCost = log.reduce((sum, e) => sum + (typeof e.cost_usd === "number" ? e.cost_usd : 0), 0);

  return (
    <div className="border-t border-rule pt-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex cursor-pointer items-center gap-2 text-xs text-muted hover:text-ink"
      >
        {open ? "Hide" : "Show"} pipeline log ({log.length} entries{totalCost > 0 ? `, ~$${totalCost.toFixed(2)}` : ""})
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-1.5 text-xs">
          {[...log].reverse().map((entry, i) => (
            <li key={i} className={`flex flex-col gap-0.5 border-l-2 pl-2 ${entry.ok ? "border-approve" : "border-flag"}`}>
              <div className="flex items-center gap-2">
                <span className="font-medium">{entry.stage}</span>
                <span className="text-muted">{new Date(entry.ts).toLocaleTimeString()}</span>
                {entry.model && <span className="text-muted">{entry.model}</span>}
                {entry.cost_usd ? <span className="text-muted">${entry.cost_usd.toFixed(4)}</span> : null}
              </div>
              {entry.error && <div className="text-flag">{entry.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
