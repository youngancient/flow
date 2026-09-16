export type SourceRow = {
  id: string;
  url: string | null;
  title: string | null;
  source_type: string;
  status: string;
  error_message: string | null;
  hasRelevantExcerpts: boolean;
};

export function SourceList({ sources }: { sources: SourceRow[] }) {
  if (sources.length === 0) {
    return <p className="text-sm text-muted">No sources yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-2 text-sm">
      {sources.map((s) => (
        <li key={s.id} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className={s.status === "ok" ? "text-approve" : "text-flag"}>
              {s.status === "ok" ? "✓" : "✕"}
            </span>
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer" className="truncate underline">
                {s.title || s.url}
              </a>
            ) : (
              <span className="text-muted">web search: {s.error_message ?? "no results"}</span>
            )}
            <span className="text-xs text-muted">{s.source_type === "scraped_url" ? "scraped" : "search result"}</span>
          </div>
          {s.status === "ok" && !s.hasRelevantExcerpts && (
            <p className="pl-6 text-xs text-muted">fetched, but no relevant excerpts found</p>
          )}
          {s.status === "failed" && s.error_message && (
            <p className="pl-6 text-xs text-flag">{s.error_message}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
