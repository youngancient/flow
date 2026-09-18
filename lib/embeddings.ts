import "server-only";

const VOYAGE_MODEL = "voyage-3.5-lite";
const MAX_CHUNK_CHARS = 1600;
const MIN_CHUNK_CHARS = 200;

/** Heuristic paragraph/heading splitter — no LLM call. Merges short fragments up to MAX_CHUNK_CHARS. */
export function chunkText(markdown: string): string[] {
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buffer = "";

  for (const paragraph of paragraphs) {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length > MAX_CHUNK_CHARS && buffer.length >= MIN_CHUNK_CHARS) {
      chunks.push(buffer);
      buffer = paragraph;
    } else {
      buffer = candidate;
    }
  }
  if (buffer) chunks.push(buffer);

  // A single very long paragraph with no natural breaks — hard-split it.
  return chunks.flatMap((chunk) => {
    if (chunk.length <= MAX_CHUNK_CHARS * 1.5) return [chunk];
    const parts: string[] = [];
    for (let i = 0; i < chunk.length; i += MAX_CHUNK_CHARS) {
      parts.push(chunk.slice(i, i + MAX_CHUNK_CHARS));
    }
    return parts;
  });
}

async function voyageEmbed(
  inputs: string[],
  inputType: "query" | "document"
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("Missing VOYAGE_API_KEY env var");
  const apiUrl = process.env.VOYAGE_EMBEDDINGS_URL;
  if (!apiUrl) throw new Error("Missing VOYAGE_EMBEDDINGS_URL env var");

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: inputs,
      model: VOYAGE_MODEL,
      input_type: inputType,
      output_dimension: 1024,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Voyage embeddings request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
  return json.data.map((d) => d.embedding);
}

/** Embeds document chunks — one batched call for all chunks of a source, per artifact/design.md cost-awareness notes. */
export async function embedDocuments(chunks: string[]): Promise<number[][]> {
  if (chunks.length === 0) return [];
  return voyageEmbed(chunks, "document");
}

/** Embeds the query (content idea + audience) used for the similarity search. Asymmetric encoding vs. embedDocuments — see artifact/design.md, "Prompting strategy". */
export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await voyageEmbed([text], "query");
  return embedding;
}
