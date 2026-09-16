import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseService } from "@/lib/supabase/service";
import { StatusBadge } from "@/components/StatusBadge";
import { PipelineLog } from "@/components/PipelineLog";
import { SourceList, type SourceRow } from "@/components/SourceList";
import { DraftOptionCard, type DraftVersion } from "@/components/DraftOptionCard";
import { EvaluationRow } from "@/components/EvaluationPanel";
import { ChannelOutputCard } from "@/components/ChannelOutputCard";
import { RetryButton } from "@/components/RetryButton";
import { PipelineProgress } from "@/components/PipelineProgress";
import { DRAFT_OPTION_LABELS } from "@/lib/rules";

const TERMINAL_STAGES = new Set(["ready_for_review", "failed"]);

export const dynamic = "force-dynamic"; // always-fresh pipeline/review state, never statically cached
export const maxDuration = 120; // hosts actions.ts's Server Actions (selectDraft, requestDraftRevision, etc.)

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = supabaseService();

  const { data: request } = await db.from("content_requests").select("*").eq("id", id).single();
  if (!request) notFound();

  const [sourcesRes, chunksRes, draftsRes, evaluationsRes, channelOutputsRes] = await Promise.all([
    db.from("sources").select("*").eq("request_id", id),
    db.from("source_chunks").select("id, source_id, relevance_selected, sources(url)").eq("request_id", id),
    db.from("drafts").select("*").eq("request_id", id).order("version"),
    db.from("evaluations").select("*, drafts!inner(request_id)").eq("drafts.request_id", id).order("created_at", { ascending: false }),
    db.from("channel_outputs").select("*").eq("request_id", id),
  ]);

  const chunksBySource = new Map<string, boolean>();
  const chunkIdToSourceUrl = new Map<string, string>();
  for (const c of chunksRes.data ?? []) {
    if (c.relevance_selected) chunksBySource.set(c.source_id, true);
    const sourcesField = c.sources as { url: string } | { url: string }[] | null;
    const sourceUrl = Array.isArray(sourcesField) ? sourcesField[0]?.url : sourcesField?.url;
    if (sourceUrl) chunkIdToSourceUrl.set(c.id, sourceUrl);
  }

  const sources: SourceRow[] = (sourcesRes.data ?? []).map((s) => ({
    id: s.id,
    url: s.url,
    title: s.title,
    source_type: s.source_type,
    status: s.status,
    error_message: s.error_message,
    hasRelevantExcerpts: chunksBySource.get(s.id) ?? false,
  }));

  const draftsByOption = new Map<string, DraftVersion[]>();
  for (const label of DRAFT_OPTION_LABELS) draftsByOption.set(label, []);
  for (const d of draftsRes.data ?? []) {
    const citedSourceUrls = Array.from(
      new Set((d.source_chunk_ids ?? []).map((chunkId: string) => chunkIdToSourceUrl.get(chunkId)).filter(Boolean))
    ) as string[];
    draftsByOption.get(d.option_label)?.push({ ...d, citedSourceUrls });
  }

  const latestEvaluationByDraftId = new Map<string, EvaluationRow>();
  for (const e of evaluationsRes.data ?? []) {
    if (!latestEvaluationByDraftId.has(e.draft_id)) {
      latestEvaluationByDraftId.set(e.draft_id, e as EvaluationRow);
    }
  }
  const evaluationsByDraftId = Object.fromEntries(latestEvaluationByDraftId);

  const channelOutputs = channelOutputsRes.data ?? [];
  const channelOrder = ["linkedin", "x", "newsletter"];
  const inProgress = !TERMINAL_STAGES.has(request.stage);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-12">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-sm text-muted underline">
          ← All requests
        </Link>
        <div className="flex items-center gap-2">
          <StatusBadge status={request.stage} />
          {request.stage === "failed" && <RetryButton requestId={id} />}
        </div>
      </div>

      <div>
        <h1 className="font-serif text-2xl">{request.raw_idea}</h1>
        <p className="text-sm text-muted">
          for: {request.target_audience}
          {request.source_url ? `, source: ${request.source_url}` : ""}
        </p>
        {request.low_grounding && (
          <p className="mt-1 text-sm text-pending">
            Low grounding — no source excerpts cleared the relevance threshold. The draft hedges specific claims.
          </p>
        )}
      </div>

      {inProgress ? (
        <PipelineProgress
          requestId={id}
          initialStage={request.stage}
          initialLog={request.pipeline_log ?? []}
          initialError={request.pipeline_error}
        />
      ) : (
        <>
          {request.stage === "failed" && request.pipeline_error && <p className="text-sm text-flag">{request.pipeline_error}</p>}

          <PipelineLog log={request.pipeline_log ?? []} />

          <section>
            <h2 className="mb-3 border-t border-rule pt-4 text-xs font-semibold text-muted">sources</h2>
            <SourceList sources={sources} />
          </section>

          {request.plan && (
            <section>
              <h2 className="mb-3 border-t border-rule pt-4 text-xs font-semibold text-muted">plan</h2>
              <p className="text-sm">
                Primary keyword: <strong>{request.plan.primary_keyword}</strong>
              </p>
              <ul className="mt-2 flex flex-col gap-1 text-sm text-muted">
                {request.plan.outline?.map((section: { heading: string; level: number }, i: number) => (
                  <li key={i} style={{ marginLeft: (section.level - 1) * 16 }}>
                    {section.heading}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {draftsRes.data && draftsRes.data.length > 0 && (
            <section>
              <h2 className="mb-3 border-t border-rule pt-4 text-xs font-semibold text-muted">drafts</h2>
              <div className="flex flex-wrap gap-4">
                {DRAFT_OPTION_LABELS.map((label) => {
                  const versions = draftsByOption.get(label) ?? [];
                  if (versions.length === 0) return null;
                  return (
                    <DraftOptionCard
                      key={label}
                      requestId={id}
                      optionLabel={label}
                      versions={versions}
                      evaluationsByDraftId={evaluationsByDraftId}
                      selectedDraftId={request.selected_draft_id}
                      hasChannelOutputs={channelOutputs.length > 0}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {channelOutputs.length > 0 && (
            <section>
              <h2 className="mb-3 border-t border-rule pt-4 text-xs font-semibold text-muted">channels</h2>
              <div className="grid gap-4 md:grid-cols-3">
                {channelOrder.map((channel) => {
                  const output = channelOutputs.find((o) => o.channel === channel);
                  return output ? <ChannelOutputCard key={output.id} output={output} /> : null;
                })}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
