import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";

export type FlaggedQuote = { quote: string; reason: string };

/**
 * Highlights any flagged quote found in plain-string children. Real React
 * <mark> elements, not raw HTML injection — see artifact/design.md,
 * "No raw HTML rendering, anywhere." Only matches direct string children of
 * a block (paragraphs/list items/headings), not text nested inside inline
 * emphasis — an honest, simple degradation for quotes that cross a
 * bold/italic boundary, not a correctness guarantee.
 */
function highlightChildren(children: ReactNode, flags: FlaggedQuote[]): ReactNode {
  if (flags.length === 0) return children;
  if (typeof children === "string") return highlightString(children, flags);
  if (Array.isArray(children)) {
    return children.map((c, i) => <span key={i}>{highlightChildren(c, flags)}</span>);
  }
  return children;
}

function highlightString(text: string, flags: FlaggedQuote[]): ReactNode {
  for (const flag of flags) {
    if (!flag.quote) continue;
    const idx = text.indexOf(flag.quote);
    if (idx !== -1) {
      const before = text.slice(0, idx);
      const match = text.slice(idx, idx + flag.quote.length);
      const after = text.slice(idx + flag.quote.length);
      return (
        <>
          {before}
          <mark className="flagged" title={flag.reason}>
            {match}
          </mark>
          {highlightString(after, flags)}
        </>
      );
    }
  }
  return text;
}

export function ArticlePreview({ bodyMarkdown, flags = [] }: { bodyMarkdown: string; flags?: FlaggedQuote[] }) {
  return (
    <div className="prose-article">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{highlightChildren(children, flags)}</p>,
          li: ({ children }) => <li>{highlightChildren(children, flags)}</li>,
          h1: ({ children }) => <h1>{highlightChildren(children, flags)}</h1>,
          h2: ({ children }) => <h2>{highlightChildren(children, flags)}</h2>,
          h3: ({ children }) => <h3>{highlightChildren(children, flags)}</h3>,
          td: ({ children }) => <td>{highlightChildren(children, flags)}</td>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {bodyMarkdown}
      </ReactMarkdown>
    </div>
  );
}
