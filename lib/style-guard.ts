/**
 * Deterministic code-side backstop for the HOUSE_STYLE prompt instructions
 * (lib/rules.ts) — a prompt instruction alone isn't 100% reliable, so this
 * runs after every generation call. See artifact/design.md, "Prompting
 * strategy".
 */

/** Replaces em dashes with lighter punctuation. Applied to ALL generated text. */
export function stripEmDashes(text: string): string {
  // "word—word" -> "word, word"; "word — word" -> "word, word"
  return text.replace(/\s*—\s*/g, ", ").replace(/\s*--\s*/g, ", ");
}

/**
 * Strips a leaked `[uuid]` citation-ID marker from generated text. Source
 * excerpts are labeled `[uuid] (source: url)` inside the prompt so the
 * model can cite them via the separate structured `source_chunk_ids`
 * field — this design deliberately uses whole-draft citation, never inline
 * markers (see artifact/design.md, "Deliberately not built": no per-claim
 * citation table). A model occasionally pattern-matches that labeling
 * convention and echoes a raw excerpt ID directly into the body text as a
 * fake inline citation, which should never be visible to a reviewer.
 * Applied to ALL generated text, alongside the matching prompt instruction
 * — same "trust but verify" discipline as the other style-guard checks.
 */
export function stripLeakedCitationIds(text: string): string {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  return text
    .replace(new RegExp(`\\s*\\[${uuid.source}\\]`, "gi"), "")
    .replace(/ {2,}/g, " ");
}

/**
 * Strips a stray empty inline-citation parenthetical, e.g. "...costs ()."
 * — the same leaked-citation habit stripLeakedCitationIds targets (the
 * model trying to cite inline despite being told to cite only via
 * source_chunk_ids), just missing the bracketed ID rather than including
 * one. There's no legitimate reason for a genuinely empty "()" (or
 * whitespace-only "( )") to appear in generated prose, so this is safe to
 * strip unconditionally, including the leading space it usually leaves.
 */
export function stripEmptyParens(text: string): string {
  return text.replace(/\s*\(\s*\)/g, "");
}

/**
 * Strips markdown syntax that shouldn't appear in plain-text channel posts
 * (LinkedIn/X/newsletter). Never applied to the article's body_markdown,
 * which legitimately is markdown.
 */
export function stripMarkdownArtifacts(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1") // italic
    .replace(/^[-*]\s+/gm, "") // bullets
    .replace(/`([^`]+)`/g, "$1"); // inline code
}

/** Applies both cleanups appropriately for a channel post body. */
export function cleanChannelText(text: string): string {
  return stripMarkdownArtifacts(stripEmptyParens(stripLeakedCitationIds(stripEmDashes(text))));
}

/** Applies only the em-dash and leaked-citation cleanups, for text that legitimately keeps markdown (the article). */
export function cleanArticleText(text: string): string {
  return stripEmptyParens(stripLeakedCitationIds(stripEmDashes(text)));
}
