import "server-only";
import { ZodError } from "zod";
import { supabaseService } from "./supabase/service";
import { assertOk } from "./supabase/assert";
import { scrapeUrl, searchWeb, type FetchedSource } from "./firecrawl";
import { chunkText, embedDocuments, embedQuery } from "./embeddings";
import {
  planAndGenerateOptions,
  evaluateDrafts,
  reviseDrafts,
  adaptToChannels,
  adaptSingleChannel,
  type ChannelName,
  type ExcerptForPrompt,
  MODEL_DRAFTING,
  MODEL_EVAL,
  MODEL_CHANNEL_ADAPT,
} from "./claude";
import { postPipelineError } from "./discord";
import { notifyReadyForReview } from "./notify";
import { redact } from "./redact";
import { MIN_SIMILARITY, MAX_REVISION_ROUNDS, DRAFT_OPTION_LABELS, X_CHAR_LIMIT, xPostCharCount } from "./rules";

type Stage = "researching" | "planning_drafting" | "evaluating" | "revising";

// Rough, illustrative $/M-token rates for cost visibility in pipeline_log —
// not billing-accurate, just enough to make cost a visible number rather
// than an invisible line item (artifact/design.md, "Cost Awareness").
// MODEL_EVAL and MODEL_CHANNEL_ADAPT currently share the same Haiku tier, so
// this is just one rate entry, not two — see lib/claude.ts's model constants.
const RATES: Record<string, { input: number; output: number }> = {
  [MODEL_DRAFTING]: { input: 3, output: 15 },
  [MODEL_EVAL]: { input: 1, output: 5 },
};

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = RATES[model] ?? { input: 3, output: 15 };
  return Math.round(((inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output) * 10000) / 10000;
}

async function appendLog(requestId: string, entry: Record<string, unknown>) {
  const db = supabaseService();
  const { data } = await db.from("content_requests").select("pipeline_log").eq("id", requestId).single();
  const log = Array.isArray(data?.pipeline_log) ? data!.pipeline_log : [];
  log.push(redact({ ...entry, ts: new Date().toISOString() }));
  await assertOk(db.from("content_requests").update({ pipeline_log: log }).eq("id", requestId), "content_requests pipeline_log update");
}

async function setStage(requestId: string, stage: Stage) {
  await assertOk(supabaseService().from("content_requests").update({ stage }).eq("id", requestId), "content_requests stage update");
}

/**
 * A raw ZodError's own `.message` is a pretty-printed JSON array of every
 * issue — accurate, but unreadable dumped straight into pipeline_error/a
 * Discord message. Claude's structured-output calls throw this whenever the
 * model's response doesn't match the expected schema (missing fields, a bad
 * enum value, etc.) — collapse it to one plain-English line instead, still
 * naming the count and the first failing field for anyone debugging it.
 */
function formatPipelineError(error: unknown): string {
  if (error instanceof ZodError) {
    const [first, ...rest] = error.issues;
    const where = first.path.join(".") || "(root)";
    const more = rest.length > 0 ? ` (+${rest.length} more issue${rest.length > 1 ? "s" : ""})` : "";
    return `Claude returned a response that didn't match the expected format at "${where}": ${first.message}${more}. This is usually a one-off malformed model output — retrying often resolves it.`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function setFailed(requestId: string, stage: string, error: unknown) {
  const message = formatPipelineError(error);
  try {
    await appendLog(requestId, { stage, ok: false, error: message });
    await assertOk(
      supabaseService().from("content_requests").update({ stage: "failed", pipeline_error: message }).eq("id", requestId),
      "content_requests failed-stage update"
    );
  } catch (writeErr) {
    // If recording the failure itself fails (e.g. Supabase is down), that
    // must never swallow the Discord alert below — this is exactly the
    // moment the team most needs to hear about it.
    console.error(`setFailed: failed to record failure for request ${requestId} (stage ${stage}):`, writeErr);
  }
  postPipelineError({ requestId, stage, error: message });
}

async function setSucceeded(requestId: string, stage: string, extra: Record<string, unknown> = {}) {
  await appendLog(requestId, { stage, ok: true, ...extra });
}

/**
 * The orchestrator. Runs research -> source selection -> plan+generate ->
 * evaluate -> revise (capped) -> ready_for_review, synchronously, updating
 * `stage` and `pipeline_log` as it goes. Every stage checks for existing
 * work before doing it, so calling this again after a crash resumes rather
 * than duplicating cost (artifact/design.md, "Pipeline execution model").
 *
 * Wrapped in a top-level try/catch so a genuinely unanticipated bug still
 * writes stage='failed' + pipeline_log + a Discord ping, not just the four
 * named external-call failure modes (artifact/design.md, "Failure
 * visibility & security").
 */
export async function runPipeline(requestId: string): Promise<void> {
  try {
    const db = supabaseService();
    const { data: request, error } = await db
      .from("content_requests")
      .select("*")
      .eq("id", requestId)
      .single();
    if (error || !request) throw new Error(`content_requests row not found: ${requestId}`);

    if (request.stage === "ready_for_review") return; // nothing to do

    // A resumed run (retry) may be starting from a row that still has a
    // stale pipeline_error from the attempt that failed, and always needs
    // pipeline_started_at reset — otherwise PipelineProgress's elapsed
    // timer anchors to the original submission time, not this attempt (can
    // read as a wildly wrong "21m elapsed" on a retry of an old request).
    // The Server Action retry path (app/requests/[id]/actions.ts) already
    // resets both synchronously before redirecting, so the UI never
    // flashes the stale values — but the curl-testable retry Route Handler
    // calls runPipeline directly with no pre-reset, so this still needs to
    // happen here too.
    await assertOk(
      db.from("content_requests").update({ pipeline_error: null, pipeline_started_at: new Date().toISOString() }).eq("id", requestId),
      "content_requests retry reset"
    );

    // ---- Stage 1: Research ------------------------------------------------
    await setStage(requestId, "researching");
    const { data: existingSources } = await db.from("sources").select("id").eq("request_id", requestId);

    if (!existingSources || existingSources.length === 0) {
      try {
        await runResearch(requestId, request.source_urls, request.raw_idea);
        await setSucceeded(requestId, "research");
      } catch (err) {
        await setFailed(requestId, "research", err);
        return;
      }
    }

    // ---- Stage 2: Source selection -----------------------------------------
    try {
      const lowGrounding = await runSourceSelection(requestId, request.raw_idea, request.target_audience);
      await setSucceeded(requestId, "source_selection", { lowGrounding });
    } catch (err) {
      await setFailed(requestId, "source_selection", err);
      return;
    }

    // ---- Stage 3: Plan + generate options -----------------------------------
    await setStage(requestId, "planning_drafting");
    const { data: existingDrafts } = await db
      .from("drafts")
      .select("id")
      .eq("request_id", requestId)
      .eq("version", 1);

    if (!existingDrafts || existingDrafts.length < DRAFT_OPTION_LABELS.length) {
      try {
        await runPlanAndGenerate(requestId, request.raw_idea, request.target_audience, request.supporting_notes);
        await setSucceeded(requestId, "plan_and_generate");
      } catch (err) {
        await setFailed(requestId, "plan_and_generate", err);
        return;
      }
    }

    // ---- Stage 4 + 5: Evaluate + bounded auto-revision loop -----------------
    await setStage(requestId, "evaluating");
    try {
      await runEvaluationAndRevisionLoop(requestId, request.raw_idea, request.target_audience);
      await setSucceeded(requestId, "evaluation_and_revision");
    } catch (err) {
      await setFailed(requestId, "evaluation_and_revision", err);
      return;
    }

    await assertOk(db.from("content_requests").update({ stage: "ready_for_review" }).eq("id", requestId), "content_requests ready_for_review update");
    await notifyReadyForReview(requestId);
  } catch (err) {
    // Backstop for anything not caught above — an unforeseen bug still gets
    // recorded, never leaves the row silently stuck.
    await setFailed(requestId, "pipeline", err);
  }
}

async function runResearch(requestId: string, sourceUrls: string[], rawIdea: string): Promise<void> {
  const db = supabaseService();
  const fetched: FetchedSource[] = [];
  const rows: Array<Record<string, unknown>> = [];

  // Scraped independently — one bad/unreachable URL doesn't stop the others
  // from being tried. Falls back to search only if every URL failed (or
  // none were given), same as the old single-URL behavior generalized to N.
  for (const sourceUrl of sourceUrls) {
    try {
      const scraped = await scrapeUrl(sourceUrl);
      fetched.push(scraped);
      rows.push({
        request_id: requestId,
        source_type: "scraped_url",
        url: scraped.url,
        title: scraped.title,
        query_used: sourceUrl,
        status: "ok",
        raw_markdown: scraped.markdown,
      });
    } catch (err) {
      rows.push({
        request_id: requestId,
        source_type: "scraped_url",
        url: sourceUrl,
        query_used: sourceUrl,
        status: "failed",
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (fetched.length === 0) {
    // No URLs given, or every scrape failed — fall back to idea-based
    // search rather than hard-failing the request.
    try {
      const results = await searchWeb(rawIdea);
      for (const r of results) {
        fetched.push(r);
        rows.push({
          request_id: requestId,
          source_type: "search_result",
          url: r.url,
          title: r.title,
          query_used: rawIdea,
          status: "ok",
          raw_markdown: r.markdown,
        });
      }
    } catch (err) {
      rows.push({
        request_id: requestId,
        source_type: "search_result",
        query_used: rawIdea,
        status: "failed",
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (rows.length > 0) {
    await assertOk(db.from("sources").insert(rows), "sources insert");
  }

  if (fetched.length === 0) {
    throw new Error("No usable sources found from search or scrape");
  }
}

async function runSourceSelection(requestId: string, rawIdea: string, targetAudience: string): Promise<boolean> {
  const db = supabaseService();

  const { data: okSources } = await db
    .from("sources")
    .select("id, raw_markdown")
    .eq("request_id", requestId)
    .eq("status", "ok");

  for (const source of okSources ?? []) {
    const { count } = await db
      .from("source_chunks")
      .select("id", { count: "exact", head: true })
      .eq("source_id", source.id);
    if (count && count > 0) continue; // already chunked/embedded — idempotent skip

    const chunks = chunkText(source.raw_markdown ?? "");
    if (chunks.length === 0) continue;

    const embeddings = await embedDocuments(chunks);
    const rows = chunks.map((text, i) => ({
      source_id: source.id,
      request_id: requestId,
      chunk_index: i,
      chunk_text: text,
      embedding: embeddings[i],
    }));
    await assertOk(db.from("source_chunks").insert(rows), "source_chunks insert");
  }

  // Reset selection flags, then recompute — cheap DB-only work, safe to redo every run.
  await assertOk(
    db.from("source_chunks").update({ relevance_selected: false }).eq("request_id", requestId),
    "source_chunks relevance reset"
  );

  const queryEmbedding = await embedQuery(`${rawIdea}\n\nAudience: ${targetAudience}`);
  const { data: matches } = await db.rpc("match_source_chunks", {
    query_embedding: queryEmbedding,
    match_request_id: requestId,
    match_count: 20,
  });

  const selected = (matches ?? []).filter((m: { similarity: number }) => m.similarity >= MIN_SIMILARITY).slice(0, 12);

  if (selected.length > 0) {
    await assertOk(
      db
        .from("source_chunks")
        .update({ relevance_selected: true })
        .in("id", selected.map((m: { id: string }) => m.id)),
      "source_chunks relevance_selected update"
    );
  }

  const lowGrounding = selected.length === 0;
  await assertOk(db.from("content_requests").update({ low_grounding: lowGrounding }).eq("id", requestId), "content_requests low_grounding update");
  return lowGrounding;
}

async function getSelectedExcerpts(requestId: string): Promise<ExcerptForPrompt[]> {
  const db = supabaseService();
  const { data } = await db
    .from("source_chunks")
    .select("id, chunk_text, sources(url)")
    .eq("request_id", requestId)
    .eq("relevance_selected", true);

  return (data ?? []).map((row: { id: string; chunk_text: string; sources: { url: string } | { url: string }[] | null }) => ({
    id: row.id,
    text: row.chunk_text,
    sourceUrl: Array.isArray(row.sources) ? row.sources[0]?.url ?? "" : row.sources?.url ?? "",
  }));
}

async function getExcerptsByIds(ids: string[]): Promise<ExcerptForPrompt[]> {
  if (ids.length === 0) return [];
  const db = supabaseService();
  const { data } = await db
    .from("source_chunks")
    .select("id, chunk_text, sources(url)")
    .in("id", ids);

  return (data ?? []).map((row: { id: string; chunk_text: string; sources: { url: string } | { url: string }[] | null }) => ({
    id: row.id,
    text: row.chunk_text,
    sourceUrl: Array.isArray(row.sources) ? row.sources[0]?.url ?? "" : row.sources?.url ?? "",
  }));
}

async function runPlanAndGenerate(
  requestId: string,
  rawIdea: string,
  targetAudience: string,
  supportingNotes: string | null
): Promise<void> {
  const db = supabaseService();
  const { data: request } = await db.from("content_requests").select("low_grounding").eq("id", requestId).single();
  const excerpts = await getSelectedExcerpts(requestId);

  const result = await planAndGenerateOptions({
    rawIdea,
    targetAudience,
    supportingNotes: supportingNotes ?? null,
    excerpts,
    lowGrounding: request?.low_grounding ?? false,
  });

  await assertOk(db.from("content_requests").update({ plan: result.plan }).eq("id", requestId), "content_requests plan update");

  const rows = result.options.map((o) => ({
    request_id: requestId,
    option_label: o.option_label,
    version: 1,
    title: o.title,
    body_markdown: o.body_markdown,
    primary_keyword: o.primary_keyword,
    secondary_keywords: o.secondary_keywords,
    source_chunk_ids: o.source_chunk_ids,
    revision_source: "initial",
  }));
  await assertOk(db.from("drafts").insert(rows), "drafts insert (initial)");

  await appendLog(requestId, {
    stage: "plan_and_generate",
    model: MODEL_DRAFTING,
    tokens: { input: result.inputTokens, output: result.outputTokens },
    cost_usd: estimateCostUsd(MODEL_DRAFTING, result.inputTokens, result.outputTokens),
  });
}

async function runEvaluationAndRevisionLoop(requestId: string, rawIdea: string, targetAudience: string): Promise<void> {
  const db = supabaseService();

  async function latestDraftsFor(labels: readonly string[]) {
    const { data } = await db
      .from("drafts")
      .select("*")
      .eq("request_id", requestId)
      .in("option_label", labels)
      .order("version", { ascending: false });
    const byLabel = new Map<string, NonNullable<typeof data>[number]>();
    for (const d of data ?? []) {
      if (!byLabel.has(d.option_label)) byLabel.set(d.option_label, d);
    }
    return byLabel;
  }

  let pendingLabels: readonly string[] = DRAFT_OPTION_LABELS;
  let round = 0;

  while (pendingLabels.length > 0 && round <= MAX_REVISION_ROUNDS) {
    const draftsByLabel = await latestDraftsFor(pendingLabels);

    // Skip evaluating a version that's already been evaluated (resume case).
    const toEvaluate: Array<{ optionLabel: string; title: string; bodyMarkdown: string; citedExcerpts: ExcerptForPrompt[]; draftId: string }> = [];
    for (const [label, draft] of draftsByLabel) {
      const { count } = await db
        .from("evaluations")
        .select("id", { count: "exact", head: true })
        .eq("draft_id", draft.id);
      if (count && count > 0) continue;

      const cited = await getExcerptsByIds(draft.source_chunk_ids ?? []);
      toEvaluate.push({ optionLabel: label, title: draft.title, bodyMarkdown: draft.body_markdown, citedExcerpts: cited, draftId: draft.id });
    }

    if (toEvaluate.length > 0) {
      const evalResult = await evaluateDrafts({ rawIdea, targetAudience, drafts: toEvaluate });

      for (const r of evalResult.results) {
        const draft = draftsByLabel.get(r.optionLabel);
        if (!draft) continue;
        await assertOk(
          db.from("evaluations").insert({
            draft_id: draft.id,
            overall_status: r.overallStatus,
            criteria: r.criteria,
            combined_score: r.combinedScore,
            unsupported_claims: r.unsupportedClaims,
            sections_needing_revision: r.sectionsNeedingRevision,
            recommended_changes: r.recommendedChanges,
            raw_response: r.rawResponse,
          }),
          "evaluations insert"
        );
      }

      await appendLog(requestId, {
        stage: `evaluate_round_${round}`,
        model: MODEL_EVAL,
        tokens: { input: evalResult.inputTokens, output: evalResult.outputTokens },
        cost_usd: estimateCostUsd(MODEL_EVAL, evalResult.inputTokens, evalResult.outputTokens),
      });
    }

    // Re-read latest evaluation per label to decide what still needs revision.
    const stillWeak: string[] = [];
    for (const [label, draft] of draftsByLabel) {
      const { data: latestEval } = await db
        .from("evaluations")
        .select("overall_status")
        .eq("draft_id", draft.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (latestEval && latestEval.overall_status !== "pass") stillWeak.push(label);
    }

    if (stillWeak.length === 0 || round === MAX_REVISION_ROUNDS) break;

    // Revise the weak ones, batched in one call.
    const excerpts = await getSelectedExcerpts(requestId);
    const revisionItems = [];
    for (const label of stillWeak) {
      const draft = draftsByLabel.get(label)!;
      const { data: latestEval } = await db
        .from("evaluations")
        .select("recommended_changes, unsupported_claims")
        .eq("draft_id", draft.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      const feedback = [
        latestEval?.recommended_changes,
        latestEval?.unsupported_claims?.length
          ? `Unsupported claims to fix: ${JSON.stringify(latestEval.unsupported_claims)}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      revisionItems.push({ optionLabel: label, currentTitle: draft.title, currentBody: draft.body_markdown, feedback: feedback || "Improve overall quality per the rubric." });
    }

    const revisionResult = await reviseDrafts({ items: revisionItems, excerpts });

    for (const rev of revisionResult.revisions) {
      const draft = draftsByLabel.get(rev.option_label)!;
      await assertOk(
        db.from("drafts").insert({
          request_id: requestId,
          option_label: rev.option_label,
          version: draft.version + 1,
          parent_draft_id: draft.id,
          title: rev.title,
          body_markdown: rev.body_markdown,
          primary_keyword: rev.primary_keyword,
          secondary_keywords: rev.secondary_keywords,
          source_chunk_ids: rev.source_chunk_ids,
          revision_source: "auto_revision",
        }),
        "drafts insert (auto_revision)"
      );
    }

    await appendLog(requestId, {
      stage: `revise_round_${round}`,
      model: MODEL_DRAFTING,
      tokens: { input: revisionResult.inputTokens, output: revisionResult.outputTokens },
      cost_usd: estimateCostUsd(MODEL_DRAFTING, revisionResult.inputTokens, revisionResult.outputTokens),
    });

    pendingLabels = stillWeak;
    round += 1;
  }
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function checkChannelViolations(result: { x: { body: string; hashtags: string[] }; newsletter: { body: string } }): string | null {
  const issues: string[] = [];
  if (result.x.hashtags.length > 2) {
    issues.push(`The X post has ${result.x.hashtags.length} hashtags; use at most 2.`);
  }
  const xLength = xPostCharCount(result.x.body, result.x.hashtags);
  if (xLength > X_CHAR_LIMIT) {
    issues.push(`The X post (with hashtags) is ${xLength} characters; it must be ${X_CHAR_LIMIT} or fewer.`);
  }
  const wordCount = countWords(result.newsletter.body);
  if (wordCount < 250 || wordCount > 600) {
    issues.push(`The newsletter body is ${wordCount} words; it must be between 250 and 600.`);
  }
  return issues.length > 0 ? issues.join(" ") : null;
}

/** Same recompute discipline as checkChannelViolations, scoped to one channel — for regenerateSingleChannelOutput. */
function checkSingleChannelViolation(channel: ChannelName, result: { body: string; hashtags?: string[] }): string | null {
  if (channel === "x") {
    const hashtags = result.hashtags ?? [];
    if (hashtags.length > 2) {
      return `The X post has ${hashtags.length} hashtags; use at most 2.`;
    }
    const xLength = xPostCharCount(result.body, hashtags);
    if (xLength > X_CHAR_LIMIT) {
      return `The X post (with hashtags) is ${xLength} characters; it must be ${X_CHAR_LIMIT} or fewer.`;
    }
  }
  if (channel === "newsletter") {
    const wordCount = countWords(result.body);
    if (wordCount < 250 || wordCount > 600) {
      return `The newsletter body is ${wordCount} words; it must be between 250 and 600.`;
    }
  }
  return null;
}

/**
 * Max total attempts (initial + corrections) for a channel-adaptation call
 * to satisfy the deterministic checks (hashtag count, X length, newsletter
 * word count). Hashtags get a hard slice() regardless as a true safety net,
 * but body text can't be safely hard-truncated without cutting it off
 * mid-sentence — so length violations need the model to actually comply,
 * re-checked after every attempt, not just retried once and accepted
 * either way.
 */
const MAX_CHANNEL_ADAPT_ATTEMPTS = 3;

/**
 * Generates all three channel outputs for a selected draft, on demand —
 * never proactively for unpicked options (artifact/design.md, Stage 7).
 * Server-recomputes anything load-bearing (hashtag count, X length,
 * newsletter word count) rather than trusting the model; keeps retrying
 * with the violation fed back until it actually complies (or gives up
 * loudly — see MAX_CHANNEL_ADAPT_ATTEMPTS).
 */
export async function generateChannelOutputs(requestId: string, draftId: string): Promise<void> {
  const db = supabaseService();
  try {
    const { data: draft } = await db.from("drafts").select("title, body_markdown").eq("id", draftId).single();
    if (!draft) throw new Error(`Draft not found: ${draftId}`);

    let result = await adaptToChannels({ title: draft.title, bodyMarkdown: draft.body_markdown });
    let violation = checkChannelViolations(result);
    let attempts = 1;
    while (violation && attempts < MAX_CHANNEL_ADAPT_ATTEMPTS) {
      result = await adaptToChannels({ title: draft.title, bodyMarkdown: draft.body_markdown, correctionNote: violation });
      violation = checkChannelViolations(result);
      attempts++;
    }
    if (violation) {
      throw new Error(`Channel adaptation still violates format rules after ${MAX_CHANNEL_ADAPT_ATTEMPTS} attempts: ${violation}`);
    }

    const hashtags = result.x.hashtags.slice(0, 2); // hard cap regardless — the recompute, not just the retry

    // PostgREST's bulk upsert derives one column list from the union of keys
    // across the array — a row that omits a key gets NULL for it, not the
    // column's default. hashtags is `not null default '{}'`, so the
    // linkedin/newsletter rows (which never set it) were sent as NULL and
    // rejected. Every row needs the exact same key set explicitly.
    //
    // This also runs when switching the selected draft after channels
    // already existed (selectDraft in app/requests/[id]/actions.ts, guarded
    // there against sent/scheduled channels) — so review/publish state and
    // any stale reviewer/schedule/error attribution from the previous
    // draft's channel outputs must be fully reset here, not left behind.
    await assertOk(
      db.from("channel_outputs").upsert(
        [
          { request_id: requestId, draft_id: draftId, channel: "linkedin", subject: null, body: result.linkedin.body, hashtags: [], review_status: "draft", review_comment: null, publish_status: "not_queued", reviewed_by: null, reviewed_at: null, scheduled_for: null, sent_at: null, last_error: null },
          { request_id: requestId, draft_id: draftId, channel: "x", subject: null, body: result.x.body, hashtags, review_status: "draft", review_comment: null, publish_status: "not_queued", reviewed_by: null, reviewed_at: null, scheduled_for: null, sent_at: null, last_error: null },
          { request_id: requestId, draft_id: draftId, channel: "newsletter", subject: result.newsletter.subject, body: result.newsletter.body, hashtags: [], review_status: "draft", review_comment: null, publish_status: "not_queued", reviewed_by: null, reviewed_at: null, scheduled_for: null, sent_at: null, last_error: null },
        ],
        { onConflict: "request_id,channel" }
      ),
      "channel_outputs upsert"
    );

    await appendLog(requestId, {
      stage: "channel_adaptation",
      model: MODEL_CHANNEL_ADAPT,
      tokens: { input: result.inputTokens, output: result.outputTokens },
      cost_usd: estimateCostUsd(MODEL_CHANNEL_ADAPT, result.inputTokens, result.outputTokens),
      regenerated_for_violation: attempts > 1,
    });
  } catch (err) {
    // A failure here used to be visible only as a toast a reviewer could
    // easily miss, with selected_draft_id already committed and nothing
    // left to explain why no channel cards ever appeared. Logging it here
    // means it shows up in this request's PipelineLog like every other
    // stage failure, and selectDraft's caller can let the reviewer retry.
    const message = err instanceof Error ? err.message : String(err);
    await appendLog(requestId, { stage: "channel_adaptation", ok: false, error: message });
    postPipelineError({ requestId, stage: "channel_adaptation", error: message });
    throw err;
  }
}

/**
 * Regenerates a single channel's output, keeping the other two untouched.
 * Uses adaptSingleChannel (not adaptToChannels) so the model is only ever
 * asked for the one channel actually being regenerated — see
 * lib/claude.ts's adaptSingleChannel comment for why the all-three call was
 * unreliable here specifically (a real bug caught in use: single-channel
 * feedback led the model to omit the other two required objects entirely,
 * surfacing as a raw Zod "Required" error with no pipeline_log trace).
 */
export async function regenerateSingleChannelOutput(channelOutputId: string, feedback?: string): Promise<void> {
  const db = supabaseService();
  const { data: output } = await db
    .from("channel_outputs")
    .select("request_id, channel, review_status, drafts(title, body_markdown)")
    .eq("id", channelOutputId)
    .single();
  if (!output) throw new Error(`Channel output not found: ${channelOutputId}`);

  const draft = Array.isArray(output.drafts) ? output.drafts[0] : output.drafts;
  if (!draft) throw new Error(`Draft for channel output not found: ${channelOutputId}`);

  const channel = output.channel as ChannelName;

  try {
    let result = await adaptSingleChannel({ channel, title: draft.title, bodyMarkdown: draft.body_markdown, correctionNote: feedback });
    let violation = checkSingleChannelViolation(channel, result);
    let attempts = 1;
    while (violation && attempts < MAX_CHANNEL_ADAPT_ATTEMPTS) {
      result = await adaptSingleChannel({
        channel,
        title: draft.title,
        bodyMarkdown: draft.body_markdown,
        correctionNote: [feedback, violation].filter(Boolean).join("\n"),
      });
      violation = checkSingleChannelViolation(channel, result);
      attempts++;
    }
    if (violation) {
      throw new Error(`${channel} adaptation still violates format rules after ${MAX_CHANNEL_ADAPT_ATTEMPTS} attempts: ${violation}`);
    }

    const patch =
      channel === "linkedin"
        ? { body: result.body }
        : channel === "x"
          ? { body: result.body, hashtags: (result.hashtags ?? []).slice(0, 2) }
          : { subject: result.subject, body: result.body };

    // Regenerating never changes review_status by itself, regardless of
    // what it currently is — the owner may want several passes at a
    // rejected/changes-requested channel before it's actually ready to go
    // back to a manager. resubmitChannelOutput is the explicit, separate
    // step for that, mirroring how generating channels doesn't auto-send
    // them for approval either.
    await assertOk(
      db
        .from("channel_outputs")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", channelOutputId),
      "channel_outputs regenerate update"
    );

    await appendLog(output.request_id, {
      stage: "channel_regenerate",
      channel,
      model: MODEL_CHANNEL_ADAPT,
      tokens: { input: result.inputTokens, output: result.outputTokens },
      cost_usd: estimateCostUsd(MODEL_CHANNEL_ADAPT, result.inputTokens, result.outputTokens),
      regenerated_for_violation: attempts > 1,
    });
  } catch (err) {
    // Same discipline as generateChannelOutputs: log to this request's
    // pipeline_log before rethrowing, so a failure here is never visible
    // only as a toast a reviewer could miss.
    const message = err instanceof Error ? err.message : String(err);
    await appendLog(output.request_id, { stage: "channel_regenerate", channel, ok: false, error: message });
    postPipelineError({ requestId: output.request_id, stage: "channel_regenerate", error: message });
    throw err;
  }
}
