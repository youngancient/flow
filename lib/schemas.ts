import { z } from "zod";
import { DRAFT_OPTION_LABELS } from "./rules";

/** Input validation for a new content request — the same layer that enforces the length caps documented in artifact/design.md. */
export const contentRequestInputSchema = z.object({
  submissionKey: z.string().uuid(),
  rawIdea: z.string().trim().min(1).max(500),
  targetAudience: z.string().trim().min(1).max(300),
  sourceUrl: z.string().trim().url().max(2000).optional().or(z.literal("")),
  supportingNotes: z.string().trim().max(5000).optional().or(z.literal("")),
});

export type ContentRequestInput = z.infer<typeof contentRequestInputSchema>;

const criterionSchema = z.object({
  score: z.number().min(1).max(5),
  notes: z.string(),
});

export const rubricCriteriaSchema = z.object({
  topic_relevance: criterionSchema,
  source_grounding: criterionSchema,
  factual_consistency: criterionSchema,
  audience_fit: criterionSchema,
  tone: criterionSchema,
  seo_fit: criterionSchema,
  channel_fit: criterionSchema,
  clarity: criterionSchema,
  completeness: criterionSchema,
});

export type RubricCriteria = z.infer<typeof rubricCriteriaSchema>;

const flaggedQuoteSchema = z.object({
  quote: z.string(),
  reason: z.string(),
});

/**
 * Citation contract, enforced structurally (artifact/design.md, "Prompting
 * strategy"): source_chunk_ids is constrained to an enum of only the excerpt
 * IDs actually passed into the call. Built dynamically per call since the
 * allowed set of IDs differs every request.
 */
export function citationArraySchema(allowedChunkIds: string[]) {
  if (allowedChunkIds.length === 0) {
    return z.array(z.string()).max(0);
  }
  return z.array(z.enum(allowedChunkIds as [string, ...string[]]));
}

export function buildDraftOptionSchema(allowedChunkIds: string[]) {
  return z.object({
    option_label: z.enum(DRAFT_OPTION_LABELS),
    title: z.string().min(1),
    body_markdown: z.string().min(1),
    primary_keyword: z.string(),
    secondary_keywords: z.array(z.string()).default([]),
    source_chunk_ids: citationArraySchema(allowedChunkIds),
  });
}

export function buildPlanAndGenerateSchema(allowedChunkIds: string[]) {
  return z.object({
    plan: z.object({
      primary_keyword: z.string(),
      outline: z.array(
        z.object({
          heading: z.string(),
          level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
          key_points: z.array(z.string()).default([]),
        })
      ),
    }),
    options: z.array(buildDraftOptionSchema(allowedChunkIds)).min(1).max(3),
  });
}

export function buildEvaluationSchema() {
  return z.object({
    results: z.array(
      z.object({
        option_label: z.enum(DRAFT_OPTION_LABELS),
        overall_status: z.enum(["pass", "revise", "reject"]),
        criteria: rubricCriteriaSchema,
        unsupported_claims: z.array(flaggedQuoteSchema).default([]),
        sections_needing_revision: z.array(flaggedQuoteSchema).default([]),
        recommended_changes: z.string().default(""),
      })
    ),
  });
}

export function buildRevisionSchema(allowedChunkIds: string[]) {
  return z.object({
    revisions: z.array(
      z.object({
        option_label: z.enum(DRAFT_OPTION_LABELS),
        title: z.string().min(1),
        body_markdown: z.string().min(1),
        primary_keyword: z.string(),
        secondary_keywords: z.array(z.string()).default([]),
        source_chunk_ids: citationArraySchema(allowedChunkIds),
      })
    ),
  });
}

export const channelAdaptationSchema = z.object({
  linkedin: z.object({
    body: z.string().min(1),
  }),
  x: z.object({
    body: z.string().min(1),
    hashtags: z.array(z.string()).max(4).default([]),
  }),
  newsletter: z.object({
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
});

export type ChannelAdaptation = z.infer<typeof channelAdaptationSchema>;
