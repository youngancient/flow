import "server-only";
import { Firecrawl } from "firecrawl";
import { assertSafeUrl } from "./security";
import { MAX_SOURCES } from "./rules";

let client: Firecrawl | null = null;

function firecrawl(): Firecrawl {
  if (client) return client;
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY env var");
  client = new Firecrawl({ apiKey });
  return client;
}

export type FetchedSource = {
  url: string;
  title: string | null;
  markdown: string;
};

/**
 * Scrapes a single URL. Runs the SSRF check first (lib/security.ts) — never
 * call this with an unvalidated user-submitted URL. `scrape()` throws
 * (SdkError) on failure rather than returning a success flag — see
 * https://docs.firecrawl.dev/sdks/node and the installed `firecrawl` v4
 * package's type defs (node_modules/firecrawl/dist/index.d.ts).
 */
export async function scrapeUrl(url: string): Promise<FetchedSource> {
  await assertSafeUrl(url);

  const doc = await firecrawl().scrape(url, { formats: ["markdown"] });

  if (!doc.markdown || doc.markdown.trim().length < 200) {
    throw new Error(`Firecrawl scrape returned empty content for ${url}`);
  }

  return {
    url: doc.metadata?.url ?? doc.metadata?.sourceURL ?? url,
    title: doc.metadata?.title ?? null,
    markdown: doc.markdown,
  };
}

/**
 * Web search for raw-idea requests. Capped at MAX_SOURCES results — an
 * unusually broad query doesn't get chunked/embedded/carried into every
 * downstream prompt unbounded. See artifact/design.md, Stage 1.
 */
export async function searchWeb(query: string): Promise<FetchedSource[]> {
  const result = await firecrawl().search(query, {
    limit: MAX_SOURCES,
    scrapeOptions: { formats: ["markdown"] },
  });

  const items = (result.web ?? []) as Array<{ url?: string; title?: string; markdown?: string }>;

  return items
    .filter((item) => item.url && item.markdown && item.markdown.trim().length >= 200)
    .slice(0, MAX_SOURCES)
    .map((item) => ({
      url: item.url!,
      title: item.title ?? null,
      markdown: item.markdown!,
    }));
}
