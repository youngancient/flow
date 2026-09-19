import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseService } from "@/lib/supabase/service";
import { requireSessionEmailOrRedirect, isManager } from "@/lib/supabase/auth";
import { StatusBadge } from "@/components/StatusBadge";
import { PipelineLog } from "@/components/PipelineLog";
import { SourceList, type SourceRow } from "@/components/SourceList";
import { DraftOptionCard, type DraftVersion } from "@/components/DraftOptionCard";
import { EvaluationRow } from "@/components/EvaluationPanel";
import { ChannelOutputCard } from "@/components/ChannelOutputCard";
import { RetryButton } from "@/components/RetryButton";
import { SendForApprovalButton } from "@/components/SendForApprovalButton";
import { PipelineProgress } from "@/components/PipelineProgress";
import { SupportingNotes } from "@/components/SupportingNotes";
import { DRAFT_OPTION_LABELS } from "@/lib/rules";
import { describeChannelStatus, hasUnresolvedChannelGenerationFailure, describeSwitchDraftBlock } from "@/lib/publishStatus";
import { LocalTime } from "@/components/LocalTime";

const TERMINAL_STAGES = new Set(["ready_for_review", "failed"]);

export const dynamic = "force-dynamic"; // always-fresh pipeline/review state, never statically cached
export const maxDuration = 120; // hosts actions.ts's Server Actions (selectDraft, requestDraftRevision, etc.)

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = supabaseService();
  const sessionEmail = await requireSessionEmailOrRedirect();

  const { data: request } = await db.from("content_requests").select("*").eq("id", id).single();
  if (!request) notFound();
  const isOwner = request.requested_by === sessionEmail;
  const viewerIsManager = await isManager();

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
  // Ground truth for what the channels were actually built from is
  // channel_outputs.draft_id — never content_requests.selected_draft_id,
  // which can diverge from it (that's exactly the mismatch the draft-switch
  // guard in selectDraft exists to prevent/catch, so this label needs to be
  // able to expose it, not paper over it by showing the current selection).
  const generatingDraft = (draftsRes.data ?? []).find((d) => d.id === channelOutputs[0]?.draft_id);
  const switchBlockReason = describeSwitchDraftBlock(channelOutputs);
  const channelOrder = ["linkedin", "x", "newsletter"];
  const inProgress = !TERMINAL_STAGES.has(request.stage);
  const statusSummary =
    request.stage === "ready_for_review"
      ? hasUnresolvedChannelGenerationFailure(request.pipeline_log, channelOutputs.length > 0)
        ? { status: "generation_failed", label: "generation_failed" }
        : describeChannelStatus(channelOutputs.map((c) => c.publish_status), channelOutputs.map((c) => c.review_status))
      : null;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-12">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-sm text-muted underline">
          ← All requests
        </Link>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <StatusBadge status={statusSummary?.status ?? request.stage} label={statusSummary?.label} />
            {request.stage === "failed" && isOwner && <RetryButton requestId={id} />}
          </div>
          <span className="text-xs text-muted">
            Created <LocalTime iso={request.created_at} withTime />
          </span>
        </div>
      </div>

      <div>
        <h1 className="font-serif text-2xl">{request.raw_idea}</h1>
        <p className="text-sm text-muted">for: {request.target_audience}</p>
        <p className="text-xs text-muted">
          Owned by {isOwner ? "You" : request.requested_by}
          {!isOwner && (viewerIsManager ? " (reviewing)" : " (read only)")}
        </p>
        {request.low_grounding && (
          <p className="mt-1 text-sm text-pending">
            Low grounding: no source excerpts cleared the relevance threshold, so the draft hedges specific claims.
          </p>
        )}
      </div>

      {inProgress ? (
        <PipelineProgress
          requestId={id}
          startedAt={request.pipeline_started_at}
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

          {request.supporting_notes && (
            <section>
              <h2 className="mb-3 border-t border-rule pt-4 text-xs font-semibold text-muted">supporting notes</h2>
              <SupportingNotes notes={request.supporting_notes} />
            </section>
          )}

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
              {(() => {
                const renderCard = (label: (typeof DRAFT_OPTION_LABELS)[number]) => {
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
                      switchBlockReason={switchBlockReason}
                      isOwner={isOwner}
                    />
                  );
                };

                // Whichever option the selected draft's id actually belongs
                // to (any version of it, not just the latest) — a plain
                // 3-way flex-wrap row works fine when nothing's decided
                // yet, but once one option collapses the other two, mixing
                // a tall full card and two short collapsed rows as equal
                // flex-1 siblings produces uneven pairings depending on
                // which slot (1st/2nd/3rd) got selected: the full card ends
                // up squeezed next to one collapsed row while the other
                // gets stranded alone, stretched across the whole width.
                // Giving the selected card its own row, and the two
                // collapsed rows a dedicated side-by-side row, makes the
                // layout identical no matter which option was picked.
                const selectedLabel = DRAFT_OPTION_LABELS.find((label) =>
                  (draftsByOption.get(label) ?? []).some((v) => v.id === request.selected_draft_id)
                );

                if (!selectedLabel) {
                  return <div className="flex flex-wrap items-start gap-4">{DRAFT_OPTION_LABELS.map(renderCard)}</div>;
                }

                return (
                  <div className="flex flex-col gap-4">
                    {renderCard(selectedLabel)}
                    {/* flex, not grid — a grid row forces every cell in it to the tallest
                        cell's height, so expanding one collapsed card's preview would stretch
                        its sibling too even though its own content never changed. */}
                    <div className="flex flex-wrap items-start gap-4">
                      {DRAFT_OPTION_LABELS.filter((label) => label !== selectedLabel).map(renderCard)}
                    </div>
                  </div>
                );
              })()}
            </section>
          )}

          {channelOutputs.length > 0 && (
            <section>
              <div className="flex items-center justify-between border-t border-rule pt-4">
                <h2 className="text-xs font-semibold text-muted">channels</h2>
                {isOwner && channelOutputs.every((o) => o.review_status === "draft") && <SendForApprovalButton requestId={id} />}
              </div>
              {generatingDraft && (
                <p className="mb-3 mt-1 text-xs text-muted">
                  Generated from Option {generatingDraft.option_label} (v{generatingDraft.version})
                </p>
              )}
              <div className="grid items-start gap-4 md:grid-cols-3">
                {channelOrder.map((channel) => {
                  const output = channelOutputs.find((o) => o.channel === channel);
                  return output ? (
                    <ChannelOutputCard key={output.id} output={output} isOwner={isOwner} isManager={viewerIsManager} viewerEmail={sessionEmail} />
                  ) : null;
                })}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
