import type { SubscriberPreview } from "@/lib/brevo";

/** Read-only — no add/remove/edit here. See artifact/design.md, "Newsletter subscribers". */
export function SubscriberList({ preview }: { preview: SubscriberPreview }) {
  const { rows, totalCount } = preview;
  const remaining = totalCount - rows.length;

  if (totalCount === 0) {
    return <p className="text-xs text-muted">No subscribers yet — add some in the Brevo dashboard.</p>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted">
        {totalCount} subscriber{totalCount === 1 ? "" : "s"} live in Brevo
      </p>
      <ul className="flex flex-col gap-1 text-sm">
        {rows.map((row) => (
          <li key={row.email} className="flex items-center justify-between gap-4">
            <span className={row.unsubscribed ? "text-muted line-through" : ""}>{row.email}</span>
            <span className="shrink-0 text-xs text-muted">
              {row.unsubscribed ? "unsubscribed" : `since ${new Date(row.createdAt).toLocaleDateString()}`}
            </span>
          </li>
        ))}
      </ul>
      {remaining > 0 && (
        <p className="text-xs text-muted">
          +{remaining} more —{" "}
          <a href="https://app.brevo.com" target="_blank" rel="noreferrer" className="underline">
            see the full list in Brevo
          </a>
        </p>
      )}
    </div>
  );
}
