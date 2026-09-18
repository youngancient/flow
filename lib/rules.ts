/**
 * SEO / channel-formatting / evaluation-rubric text, injected into prompts
 * verbatim — never paraphrased. Sourced from artifact/assets/*.md at
 * write-time (no runtime fs reads). Updating those files means updating
 * these constants to match; compliance stays auditable by direct comparison.
 * See artifact/design.md, "Prompting strategy".
 */

export const SEO_BEST_PRACTICES = `
## Keyword Integration

- Get the primary keyword from the content idea.
- Include the primary keyword in the article title.
- Include the primary keyword in the first 100 words.
- Analyze strong competing or reference articles to identify long-tail and short-tail keywords.
- Use relevant secondary keywords in the body and section headers.

## Structure Optimization

- Use one H1 title.
- Use H2 section headers.
- Use H3 subheaders where needed.
- Use short paragraphs of 2 to 3 sentences.
- Let the depth of each main section reflect the strength and complexity of the source material.

## Content Enrichment

- Include 2 to 3 relevant internal or external links.
- Keep the writing readable for a broad audience.
- Include one contextually relevant image if the content needs one.
- Keep claims grounded in reviewed source material.
`.trim();

const LINKEDIN_FORMATTING_RULES = `
## LinkedIn Post

- Use the PAS copywriting structure: problem, agitation, solution.
- Keep paragraphs short.
- Use bullets or simple symbols when they improve clarity.
- Use a small number of relevant emojis only when they fit the brand voice.
- End with a clear call to action.
- Include a relevant image or carousel if useful.
`.trim();

const X_FORMATTING_RULES = `
## X Post

- Lead with the main benefit, insight, or hook.
- Keep the post focused on one core idea.
- Use line breaks for readability.
- Keep the total post length, including hashtags, under 280 characters. Short posts get read more.
- Use no more than 1 to 2 relevant hashtags.
- Tag another account only if the tag adds value.
`.trim();

const NEWSLETTER_FORMATTING_RULES = `
## Email Newsletter

- Use a strong subject line with a clear benefit or point of intrigue.
- Start with a short intro of 1 to 3 sentences.
- Make the main value section easy to skim with subheadings or bullets.
- Add an optional secondary item, such as a quick tip, link, or update.
- Include a clear call to action.
- Use a friendly sign-off.
- Write like you are speaking to a smart, busy reader who trusts you to send something useful.
- Keep the newsletter between 250 and 600 words.
`.trim();

/** Combined, for the initial 3-channel generation call (adaptToChannels). */
export const CHANNEL_FORMATTING_RULES = [
  LINKEDIN_FORMATTING_RULES,
  X_FORMATTING_RULES,
  NEWSLETTER_FORMATTING_RULES,
].join("\n\n");

/** Per-channel, for a single-channel regenerate call (adaptSingleChannel) — only the relevant platform's rules go in the prompt. */
export const CHANNEL_RULES_BY_CHANNEL = {
  linkedin: LINKEDIN_FORMATTING_RULES,
  x: X_FORMATTING_RULES,
  newsletter: NEWSLETTER_FORMATTING_RULES,
} as const;

export const CONTENT_EVALUATION_RUBRIC = `
## Evaluation Criteria

| Criterion | What To Check |
| --- | --- |
| Topic Relevance | The content answers the request and stays focused on the intended topic. |
| Source Grounding | Claims, examples, and recommendations connect back to reviewed source material. |
| Factual Consistency | The content avoids contradictions, unsupported claims, and invented details. |
| Audience Fit | The content speaks to the target audience at the right level of depth. |
| Tone | The style matches the brand and channel. |
| SEO Fit | The article uses the primary keyword, relevant secondary keywords, clear headings, and useful links. |
| Channel Fit | Each adapted output follows the platform formatting rules. |
| Clarity | The content is easy to read, skimmable, and direct. |
| Completeness | The output includes every required section or channel asset. |

## Suggested Evaluation Output

For each draft, the evaluation should include:

- Overall status: pass, revise, or reject
- Scores or short notes for the criteria above
- Unsupported or weak claims to remove or rewrite
- Sections that need revision
- Specific recommended changes
- Final approval status
`.trim();

/**
 * The user's own "write like a human" rule — injected verbatim into every
 * content-generation call (plan+generate, both revision paths, channel
 * adaptation). Backed by a deterministic code-side check in style-guard.ts,
 * not just this instruction. See artifact/design.md, "Prompting strategy".
 */
export const HOUSE_STYLE = `
## House Style — write like a human, not an AI

- Never use em dashes. Use a comma, period, or parentheses instead.
- Never write "it's not just X, it's Y" contrast constructions.
- Never open with "here's the ..."
- Don't stack rule-of-three constructions in every sentence.
- Don't hedge with "it's worth noting" or "it's important to note that."
- Don't close with a vague, uplifting, motivational line.
- Vary sentence length deliberately, so the rhythm reads like one person actually wrote it, not evenly-paced generated prose.
- Avoid AI-cliché vocabulary: leverage, delve, tapestry, unlock, elevate, game-changer, seamless, "in today's fast-paced world."
- If the request's supporting material includes a sample of the target voice or tone, match that voice instead of defaulting to a generic one.
- Never write a bracketed ID like [a1b2c3d4-...] anywhere in the body text. Source excerpts are labeled that way only so you know which ones to reference in the separate source_chunk_ids field; that label must never appear inside the actual writing itself.

## For LinkedIn, X, and the newsletter specifically

Plain text only. No markdown syntax — no **bold**, no # headings, no markdown bullets. Those platforms do not render markdown; literal asterisks and hash marks showing up in a post are an obvious tell that it was AI-generated.
`.trim();

export const MAX_SOURCES = 5;
/** Cap on user-supplied source URLs per request (RequestForm, contentRequestInputSchema). */
export const MAX_SOURCE_URLS = 3;
export const MIN_SIMILARITY = 0.35;
export const MAX_REVISION_ROUNDS = 2;
export const MAX_HUMAN_REVISION_ROUNDS = 3;
export const DRAFT_OPTION_LABELS = ["A", "B", "C"] as const;

/**
 * Standard (non-Premium) X post limit — assumed for this app's posting
 * account. Shared by the server-side generation/regeneration checks
 * (lib/pipeline.ts) and the client-side preview counter (XPreview.tsx) so
 * they can never disagree on what counts toward the limit.
 */
export const X_CHAR_LIMIT = 280;

/** Total X post length as X counts it: the body plus every hashtag, each with its leading space and "#". */
export function xPostCharCount(body: string, hashtags: string[]): number {
  return body.length + hashtags.reduce((sum, h) => sum + ` #${h}`.length, 0);
}
