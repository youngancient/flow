import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ZodError } from "zod";
import {
  buildPlanAndGenerateSchema,
  buildEvaluationSchema,
  buildRevisionSchema,
  channelAdaptationSchema,
  singleChannelSchemas,
  type RubricCriteria,
} from "./schemas";
import {
  SEO_BEST_PRACTICES,
  CHANNEL_FORMATTING_RULES,
  CHANNEL_RULES_BY_CHANNEL,
  CONTENT_EVALUATION_RUBRIC,
  HOUSE_STYLE,
  DRAFT_OPTION_LABELS,
} from "./rules";
import { cleanArticleText, cleanChannelText, stripLeakedCitationIds } from "./style-guard";

/**
 * Model tiering — a deliberate cost-awareness decision (artifact/design.md,
 * "Stage detail, model tiering, and guardrails"): Sonnet where output
 * quality is the product, Haiku where the task is closer to
 * classification/reformatting. Named constants so a tier change is a
 * one-line, auditable edit.
 */
export const MODEL_DRAFTING = "claude-sonnet-5";
export const MODEL_REVISE = "claude-sonnet-5";
export const MODEL_EVAL = "claude-haiku-4-5-20251001";
export const MODEL_CHANNEL_ADAPT = "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY env var");
  client = new Anthropic({ apiKey });
  return client;
}

export type LlmCallResult<T> = {
  data: T;
  inputTokens: number;
  outputTokens: number;
};

type ToolCallParams = {
  model: string;
  system: string;
  userPrompt: string;
  maxTokens: number;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
};

/**
 * Generic structured-output call via forced tool use. The caller
 * zod-validates the returned input afterward — "trust but verify" applies
 * even with structured outputs (artifact/design.md, "Prompting strategy").
 *
 * Deliberately does not set `temperature` (or top_p/top_k): Claude Sonnet 5
 * (and Opus 4.8+, Fable 5) reject any non-default value for these with a
 * 400 "temperature is deprecated for this model" — the SDK's TypeScript
 * types still declare the field for compatibility with earlier models, so
 * it type-checks fine but the API rejects it at runtime. Per-stage
 * temperature tiering was already a secondary nudge on top of the explicit
 * "3 distinctly angled options" prompt instruction, not the only mechanism
 * for output diversity, so losing it isn't a functional regression — see
 * artifact/design.md, "Prompting strategy."
 */
async function callTool({
  model,
  system,
  userPrompt,
  maxTokens,
  toolName,
  toolDescription,
  inputSchema,
}: ToolCallParams): Promise<LlmCallResult<unknown>> {
  const message = await anthropic().messages.create({
    model,
    max_tokens: maxTokens,
    system: `${system}\n\n${HOUSE_STYLE}`,
    messages: [{ role: "user", content: userPrompt }],
    tools: [
      {
        name: toolName,
        description: toolDescription,
        input_schema: inputSchema as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: toolName },
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error(`Claude did not return a ${toolName} tool call`);
  }
  if (message.stop_reason === "max_tokens") {
    // The tool-call JSON gets cut off mid-generation once max_tokens is hit,
    // so whatever fields the model hadn't written yet come back missing
    // entirely. Without this check that surfaces downstream as an opaque
    // Zod "Required" error on some field alphabetically/positionally later
    // in the schema (e.g. adaptToChannels truncating after "linkedin," so
    // "x" and "newsletter" look absent rather than truncated) — a
    // misleading error for what's actually a token-budget problem.
    throw new Error(`Claude's ${toolName} response was truncated at maxTokens=${maxTokens}. Raise it.`);
  }

  return {
    data: toolUse.input,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

/**
 * Max total attempts for a schema-validation failure — a single malformed
 * field somewhere in the response (bad enum value, an empty required
 * string, a whole missing object) that isn't a max_tokens truncation and
 * isn't the deterministic rule-violation retry adaptToChannels already
 * does — same "ask again, it's probably a one-off" reasoning, just for
 * structural validity instead of content rules. Only a ZodError triggers a
 * retry; any other error (a real API failure, a missing tool call,
 * truncation) rethrows immediately, since those aren't the kind of problem
 * a second identical attempt is likely to fix. Was 2 — observed in testing
 * that a low/zero-grounding evaluation (nothing real to cite) fails schema
 * validation more often than normal, and 2 attempts wasn't always enough
 * to avoid surfacing as a full pipeline failure even though a subsequent
 * manual retry succeeded.
 */
const MAX_SCHEMA_RETRY_ATTEMPTS = 3;

async function callToolWithRetry<T>(
  params: ToolCallParams,
  parse: (data: unknown) => T
): Promise<LlmCallResult<T>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_SCHEMA_RETRY_ATTEMPTS; attempt++) {
    const result = await callTool(params);
    try {
      return { data: parse(result.data), inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    } catch (err) {
      if (!(err instanceof ZodError)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

const chunkIdSchema = (allowedChunkIds: string[]) => ({
  type: "array",
  items: allowedChunkIds.length > 0 ? { type: "string", enum: allowedChunkIds } : { type: "string" },
});

// ---------------------------------------------------------------------------
// Stage 3: plan + generate options
// ---------------------------------------------------------------------------

export type ExcerptForPrompt = { id: string; sourceUrl: string; text: string };

export async function planAndGenerateOptions(params: {
  rawIdea: string;
  targetAudience: string;
  supportingNotes: string | null;
  excerpts: ExcerptForPrompt[];
  lowGrounding: boolean;
}) {
  const allowedChunkIds = params.excerpts.map((e) => e.id);

  const excerptsBlock = params.excerpts.length
    ? params.excerpts
        .map((e) => `[${e.id}] (source: ${e.sourceUrl})\n${e.text}`)
        .join("\n\n---\n\n")
    : "(No excerpts cleared the relevance threshold — see grounding note below.)";

  const groundingNote = params.lowGrounding
    ? "\nGROUNDING WARNING: none of the retrieved source material was relevant enough to use. Write from general knowledge, hedge every specific claim explicitly (e.g. \"generally,\" \"in many cases\"), and do not invent statistics, quotes, or specific facts. Leave source_chunk_ids empty for every option.\n"
    : "";

  const userPrompt = `
Content idea: ${params.rawIdea}
Target audience: ${params.targetAudience}
${params.supportingNotes ? `Supporting material / voice sample from the requester: ${params.supportingNotes}\n` : ""}
${groundingNote}
Available source excerpts (cite ONLY these IDs in source_chunk_ids, never invent an ID):
${excerptsBlock}

If excerpts from different sources disagree on a fact, figure, or stance, do not blend them into a single unqualified claim. Prefer the more authoritative or more recent source, and briefly note the discrepancy in the text (e.g. "some sources report X, though Y is more recent") rather than silently picking one side.

Produce a content plan (primary keyword + outline) and exactly 3 distinct article options (labeled A, B, C). Give the three options genuinely different angles — for example one data-led, one narrative/case-study-led, one practical how-to — so they are meaningfully different choices, not near-duplicates. Follow these SEO rules:

${SEO_BEST_PRACTICES}

Every option's body_markdown must be well-formed markdown (one H1, H2 sections, H3 where needed). Cite the excerpts that actually support each claim via source_chunk_ids — do not cite an excerpt that doesn't support what you wrote, and never reference an ID that wasn't given to you above.
`.trim();

  const result = await callToolWithRetry({
    model: MODEL_DRAFTING,
    system:
      "You are a senior content strategist and SEO editor for a marketing agency. You write clearly, cite only the source material you're given, and never fabricate facts, statistics, or quotes.",
    userPrompt,
    maxTokens: 8000,
    toolName: "submit_plan_and_options",
    toolDescription: "Submit the content plan and three distinct article options.",
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "object",
          properties: {
            primary_keyword: { type: "string" },
            outline: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  heading: { type: "string" },
                  level: { type: "integer", enum: [1, 2, 3] },
                  key_points: { type: "array", items: { type: "string" } },
                },
                required: ["heading", "level"],
              },
            },
          },
          required: ["primary_keyword", "outline"],
        },
        options: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              option_label: { type: "string", enum: DRAFT_OPTION_LABELS },
              title: { type: "string" },
              body_markdown: { type: "string" },
              primary_keyword: { type: "string" },
              secondary_keywords: { type: "array", items: { type: "string" } },
              source_chunk_ids: chunkIdSchema(allowedChunkIds),
            },
            required: ["option_label", "title", "body_markdown", "primary_keyword", "source_chunk_ids"],
          },
        },
      },
      required: ["plan", "options"],
    },
  }, (data) => buildPlanAndGenerateSchema(allowedChunkIds).parse(data));

  const parsed = result.data;
  parsed.options = parsed.options.map((o) => ({ ...o, body_markdown: cleanArticleText(o.body_markdown) }));

  return { ...parsed, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

// ---------------------------------------------------------------------------
// Stage 4: evaluate — 1 batched call across all drafts
// ---------------------------------------------------------------------------

export async function evaluateDrafts(params: {
  rawIdea: string;
  targetAudience: string;
  drafts: Array<{ optionLabel: string; title: string; bodyMarkdown: string; citedExcerpts: ExcerptForPrompt[] }>;
}) {
  const draftsBlock = params.drafts
    .map((d) => {
      const excerptsBlock = d.citedExcerpts.length
        ? d.citedExcerpts.map((e) => `[${e.id}] ${e.text}`).join("\n\n")
        : "(none cited)";
      return `=== Option ${d.optionLabel}: "${d.title}" ===\n${d.bodyMarkdown}\n\n--- Excerpts this option cites (verify claims against this text, not just against the draft's own prose) ---\n${excerptsBlock}`;
    })
    .join("\n\n=====\n\n");

  const userPrompt = `
Original content idea: ${params.rawIdea}
Target audience: ${params.targetAudience}

Evaluate each of the following draft options against this rubric:

${CONTENT_EVALUATION_RUBRIC}

For topic_relevance specifically: score how well the draft actually addresses the original content idea and audience above, not just whether the draft is internally coherent and well-sourced. A well-written, well-grounded article that has drifted onto a different topic than the one requested must score low on topic_relevance even if every other criterion is strong.

For unsupported_claims and sections_needing_revision, quote the flagged text VERBATIM from the draft body — do not paraphrase or describe it, since the exact quote is used to highlight it in place for the reviewer.

In every "reason" and in recommended_changes, never reference an excerpt by its bracketed ID (e.g. "[a1f2093f-...]") — that ID is an internal label for you, not something a human reviewer can make sense of. Describe the excerpt instead (e.g. "the source describing space resource commoditization").

${draftsBlock}
`.trim();

  const result = await callToolWithRetry({
    model: MODEL_EVAL,
    system:
      "You are a rigorous, skeptical content quality reviewer. You have no stake in any draft passing. Flag every claim that isn't traceable to the provided excerpts.",
    userPrompt,
    maxTokens: 6000,
    toolName: "submit_evaluations",
    toolDescription: "Submit a rubric evaluation for every draft option provided.",
    inputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              option_label: { type: "string", enum: DRAFT_OPTION_LABELS },
              overall_status: { type: "string", enum: ["pass", "revise", "reject"] },
              criteria: {
                type: "object",
                properties: Object.fromEntries(
                  [
                    "topic_relevance",
                    "source_grounding",
                    "factual_consistency",
                    "audience_fit",
                    "tone",
                    "seo_fit",
                    "channel_fit",
                    "clarity",
                    "completeness",
                  ].map((key) => [
                    key,
                    {
                      type: "object",
                      properties: { score: { type: "number", minimum: 1, maximum: 5 }, notes: { type: "string" } },
                      required: ["score", "notes"],
                    },
                  ])
                ),
              },
              unsupported_claims: {
                type: "array",
                items: {
                  type: "object",
                  properties: { quote: { type: "string" }, reason: { type: "string" } },
                  required: ["quote", "reason"],
                },
              },
              sections_needing_revision: {
                type: "array",
                items: {
                  type: "object",
                  properties: { quote: { type: "string" }, reason: { type: "string" } },
                  required: ["quote", "reason"],
                },
              },
              recommended_changes: { type: "string" },
            },
            required: ["option_label", "overall_status", "criteria"],
          },
        },
      },
      required: ["results"],
    },
  }, (data) => buildEvaluationSchema().parse(data));

  const parsed = result.data;

  const normalized = parsed.results.map((r) => normalizeEvaluation(r));

  return { results: normalized, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

export type NormalizedEvaluation = ReturnType<typeof normalizeEvaluation>;

/**
 * Deterministic guardrail: if source_grounding, factual_consistency, or
 * topic_relevance scores low, force overall_status to at most 'revise' even
 * if the model said 'pass'. topic_relevance is included alongside the other
 * two because a draft can be well-grounded and factually consistent with
 * its own cited sources while having drifted onto a topic other than the
 * one actually requested (e.g. a nonsense idea that happens to share a
 * token with an unrelated real topic) — that's exactly the kind of
 * self-consistent-but-wrong case this guardrail exists to catch, not just
 * trust the model's own pass/fail call for. The raw model output is
 * preserved alongside so the discrepancy stays visible. See
 * artifact/design.md, Stage 4.
 */
function normalizeEvaluation(r: {
  option_label: "A" | "B" | "C";
  overall_status: "pass" | "revise" | "reject";
  criteria: RubricCriteria;
  unsupported_claims: Array<{ quote: string; reason: string }>;
  sections_needing_revision: Array<{ quote: string; reason: string }>;
  recommended_changes: string;
}) {
  const scores = Object.values(r.criteria).map((c) => c.score);
  const combined_score = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;

  let overall_status = r.overall_status;
  const groundingWeak = r.criteria.source_grounding.score <= 2;
  const factsWeak = r.criteria.factual_consistency.score <= 2;
  const offTopic = r.criteria.topic_relevance.score <= 2;
  if ((groundingWeak || factsWeak || offTopic) && overall_status === "pass") {
    overall_status = "revise";
  }

  // Deterministic backstop for the prompt instruction above — the "quote"
  // field is left untouched since it must stay byte-for-byte verbatim from
  // the (already-cleaned) draft body for ArticlePreview's highlight-in-place
  // indexOf match to work; only "reason" and recommended_changes are
  // reviewer-facing prose that can leak a raw excerpt ID.
  const cleanFlags = (flags: Array<{ quote: string; reason: string }>) =>
    flags.map((f) => ({ ...f, reason: stripLeakedCitationIds(f.reason) }));

  return {
    optionLabel: r.option_label,
    overallStatus: overall_status,
    combinedScore: combined_score,
    criteria: r.criteria,
    unsupportedClaims: cleanFlags(r.unsupported_claims),
    sectionsNeedingRevision: cleanFlags(r.sections_needing_revision),
    recommendedChanges: stripLeakedCitationIds(r.recommended_changes),
    rawResponse: r,
  };
}

// ---------------------------------------------------------------------------
// Stage 5 / human revision: revise weak drafts — batched, reused by both
// the automated revision loop and the human-requested-AI-revision path.
// ---------------------------------------------------------------------------

export async function reviseDrafts(params: {
  items: Array<{
    optionLabel: string;
    currentTitle: string;
    currentBody: string;
    feedback: string;
  }>;
  excerpts: ExcerptForPrompt[];
}) {
  const allowedChunkIds = params.excerpts.map((e) => e.id);
  const excerptsBlock = params.excerpts.length
    ? params.excerpts.map((e) => `[${e.id}] ${e.text}`).join("\n\n")
    : "(none available)";

  const itemsBlock = params.items
    .map(
      (item) =>
        `=== Revise option ${item.optionLabel}: "${item.currentTitle}" ===\nCurrent body:\n${item.currentBody}\n\nFeedback to address:\n${item.feedback}`
    )
    .join("\n\n=====\n\n");

  const userPrompt = `
Revise the following draft(s) to address the feedback given for each. Make targeted fixes — preserve what already works, change only what's flagged. Stay grounded in these source excerpts (cite only these IDs, never invent one):

${excerptsBlock}

Continue following these SEO rules:

${SEO_BEST_PRACTICES}

${itemsBlock}
`.trim();

  const result = await callToolWithRetry({
    model: MODEL_REVISE,
    system:
      "You are revising a draft based on specific feedback. Make targeted fixes, not a wholesale rewrite. Stay grounded in the provided source excerpts.",
    userPrompt,
    maxTokens: 8000,
    toolName: "submit_revisions",
    toolDescription: "Submit the revised version of each draft.",
    inputSchema: {
      type: "object",
      properties: {
        revisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              option_label: { type: "string", enum: DRAFT_OPTION_LABELS },
              title: { type: "string" },
              body_markdown: { type: "string" },
              primary_keyword: { type: "string" },
              secondary_keywords: { type: "array", items: { type: "string" } },
              source_chunk_ids: chunkIdSchema(allowedChunkIds),
            },
            required: ["option_label", "title", "body_markdown", "primary_keyword", "source_chunk_ids"],
          },
        },
      },
      required: ["revisions"],
    },
  }, (data) => buildRevisionSchema(allowedChunkIds).parse(data));

  const parsed = result.data;
  parsed.revisions = parsed.revisions.map((r) => ({ ...r, body_markdown: cleanArticleText(r.body_markdown) }));

  return { ...parsed, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

// ---------------------------------------------------------------------------
// Stage 7: channel adaptation
// ---------------------------------------------------------------------------

export async function adaptToChannels(params: {
  title: string;
  bodyMarkdown: string;
  correctionNote?: string;
}) {
  const userPrompt = `
Adapt this approved article into LinkedIn, X, and email newsletter formats, following the platform rules exactly:

${CHANNEL_FORMATTING_RULES}

${params.correctionNote ? `IMPORTANT CORRECTION FROM A PREVIOUS ATTEMPT: ${params.correctionNote}\n` : ""}
Article title: ${params.title}
Article body:
${params.bodyMarkdown}
`.trim();

  const result = await callToolWithRetry({
    model: MODEL_CHANNEL_ADAPT,
    system:
      "You are a platform-formatting specialist. Reformat the given article for each channel; do not add new claims beyond what's in the article.",
    userPrompt,
    maxTokens: 6000, // was 3000 — too tight for a long article, causing silent truncation (see callTool's stop_reason check)
    toolName: "submit_channel_adaptations",
    toolDescription: "Submit the LinkedIn, X, and newsletter adaptations.",
    inputSchema: {
      type: "object",
      properties: {
        linkedin: {
          type: "object",
          properties: { body: { type: "string" } },
          required: ["body"],
        },
        x: {
          type: "object",
          properties: { body: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } },
          required: ["body"],
        },
        newsletter: {
          type: "object",
          properties: { subject: { type: "string" }, body: { type: "string" } },
          required: ["subject", "body"],
        },
      },
      required: ["linkedin", "x", "newsletter"],
    },
  }, (data) => channelAdaptationSchema.parse(data));

  const parsed = result.data;

  return {
    linkedin: { body: cleanChannelText(parsed.linkedin.body) },
    x: { body: cleanChannelText(parsed.x.body), hashtags: parsed.x.hashtags },
    newsletter: { subject: cleanChannelText(parsed.newsletter.subject), body: cleanChannelText(parsed.newsletter.body) },
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Single-channel regenerate — used by regenerateSingleChannelOutput
// (lib/pipeline.ts), never by the initial 3-channel generation
// (generateChannelOutputs, which still uses adaptToChannels above).
//
// adaptToChannels' schema requires all three of {linkedin, x, newsletter} in
// one tool call. Anthropic's tool use isn't strictly schema-enforced, so
// when a regenerate call carries feedback scoped to one channel, the model
// can (and in practice did) omit the other two required objects entirely —
// a normal, complete stop, not a max_tokens truncation, so callTool's
// stop_reason check never catches it; it surfaces instead as a raw Zod
// "Required" error on whichever fields were missing. Asking for only the
// one channel that's actually being regenerated removes the failure mode
// by construction: there's nothing for the model to "helpfully" omit.
// ---------------------------------------------------------------------------

export type ChannelName = "linkedin" | "x" | "newsletter";

const SINGLE_CHANNEL_TOOL_SCHEMA: Record<ChannelName, Record<string, unknown>> = {
  linkedin: {
    type: "object",
    properties: { body: { type: "string" } },
    required: ["body"],
  },
  x: {
    type: "object",
    properties: { body: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } },
    required: ["body"],
  },
  newsletter: {
    type: "object",
    properties: { subject: { type: "string" }, body: { type: "string" } },
    required: ["subject", "body"],
  },
};

export type SingleChannelResult = {
  body: string;
  hashtags?: string[];
  subject?: string;
  inputTokens: number;
  outputTokens: number;
};

export async function adaptSingleChannel(params: {
  channel: ChannelName;
  title: string;
  bodyMarkdown: string;
  correctionNote?: string;
}): Promise<SingleChannelResult> {
  const { channel } = params;

  const userPrompt = `
Adapt this approved article into a ${channel} post, following the platform rules exactly:

${CHANNEL_RULES_BY_CHANNEL[channel]}

${params.correctionNote ? `IMPORTANT CORRECTION FROM A PREVIOUS ATTEMPT: ${params.correctionNote}\n` : ""}
Article title: ${params.title}
Article body:
${params.bodyMarkdown}
`.trim();

  const result = await callToolWithRetry(
    {
      model: MODEL_CHANNEL_ADAPT,
      system:
        "You are a platform-formatting specialist. Reformat the given article for one channel; do not add new claims beyond what's in the article.",
      userPrompt,
      maxTokens: 3000,
      toolName: `submit_${channel}_adaptation`,
      toolDescription: `Submit the ${channel} adaptation only.`,
      inputSchema: SINGLE_CHANNEL_TOOL_SCHEMA[channel],
    },
    (data) => {
      if (channel === "linkedin") return singleChannelSchemas.linkedin.parse(data);
      if (channel === "x") return singleChannelSchemas.x.parse(data);
      return singleChannelSchemas.newsletter.parse(data);
    }
  );

  if (channel === "linkedin") {
    const parsed = result.data as ReturnType<typeof singleChannelSchemas.linkedin.parse>;
    return { body: cleanChannelText(parsed.body), inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  }
  if (channel === "x") {
    const parsed = result.data as ReturnType<typeof singleChannelSchemas.x.parse>;
    return {
      body: cleanChannelText(parsed.body),
      hashtags: parsed.hashtags,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }
  const parsed = result.data as ReturnType<typeof singleChannelSchemas.newsletter.parse>;
  return {
    body: cleanChannelText(parsed.body),
    subject: cleanChannelText(parsed.subject),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
