import type { ReactNode } from "react";

/** Label (sentence case, no colon) + a big sans-semibold value — the standard stat-tile contract. */
export function StatTile({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border border-rule p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {children}
    </div>
  );
}
