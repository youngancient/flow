import Link from "next/link";
import { StatusBadge } from "./StatusBadge";
import { LocalTime } from "./LocalTime";

export type QueueRow = {
  id: string;
  request_id: string;
  raw_idea: string;
  channel: "linkedin" | "x" | "newsletter";
  subject: string | null;
  publish_status: string;
  scheduled_for: string | null;
  sent_at: string | null;
  last_error: string | null;
};

export function QueueTable({ rows }: { rows: QueueRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted">Nothing queued, scheduled, or sent yet.</p>;
  }

  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-rule text-xs text-muted">
          <th className="py-2 pr-4">Request</th>
          <th className="py-2 pr-4">Channel</th>
          <th className="py-2 pr-4">Status</th>
          <th className="py-2">When</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-b border-rule">
            <td className="py-2 pr-4">
              <Link href={`/requests/${row.request_id}`} className="underline">
                {row.subject ?? row.raw_idea.slice(0, 60)}
              </Link>
            </td>
            <td className="py-2 pr-4 capitalize">{row.channel}</td>
            <td className="py-2 pr-4">
              <StatusBadge status={row.publish_status} />
            </td>
            <td className="py-2 text-xs text-muted">
              {row.publish_status === "sent" && row.sent_at ? (
                <>sent <LocalTime iso={row.sent_at} withTime /></>
              ) : row.publish_status === "scheduled" && row.scheduled_for ? (
                <>scheduled for <LocalTime iso={row.scheduled_for} withTime /></>
              ) : (
                "—"
              )}
              {row.last_error && <span className="text-flag">, {row.last_error}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
