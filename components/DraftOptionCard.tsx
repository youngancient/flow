"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ArticlePreview } from "./ArticlePreview";
import { EvaluationPanel, type EvaluationRow } from "./EvaluationPanel";
import { selectDraft, editDraft, requestDraftRevision } from "@/app/requests/[id]/actions";

export type DraftVersion = {
  id: string;
  version: number;
  title: string;
  body_markdown: string;
  revision_source: "initial" | "auto_revision" | "human_edit" | "human_requested_ai";
  revised_by: string | null;
  revision_feedback: string | null;
  citedSourceUrls?: string[];
};

const SOURCE_LABEL: Record<DraftVersion["revision_source"], string> = {
  initial: "generated",
  auto_revision: "auto-revised",
  human_edit: "edited by you",
  human_requested_ai: "AI-revised on your feedback",
};

export function DraftOptionCard({
  requestId,
  optionLabel,
  versions,
  evaluationsByDraftId,
  selectedDraftId,
  hasChannelOutputs,
}: {
  requestId: string;
  optionLabel: string;
  versions: DraftVersion[];
  evaluationsByDraftId: Record<string, EvaluationRow | undefined>;
  selectedDraftId: string | null;
  hasChannelOutputs: boolean;
}) {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const latest = sorted[sorted.length - 1];
  const [viewedId, setViewedId] = useState(latest.id);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [feedback, setFeedback] = useState("");
  const [showFeedbackInput, setShowFeedbackInput] = useState(false);
  const [pending, setPending] = useState(false);

  const viewed = sorted.find((v) => v.id === viewedId) ?? latest;
  const evaluation = evaluationsByDraftId[viewed.id];
  const isSelected = selectedDraftId === viewed.id;

  function startEdit() {
    setEditTitle(viewed.title);
    setEditBody(viewed.body_markdown);
    setMode("edit");
  }

  async function handleSaveEdit() {
    setPending(true);
    const res = await editDraft(viewed.id, { title: editTitle, bodyMarkdown: editBody });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Edit saved as a new version");
    setMode("preview");
  }

  async function handleSelect(draftId: string) {
    const retrying = isSelected && !hasChannelOutputs;
    setPending(true);
    const res = await selectDraft(requestId, draftId);
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(retrying ? "Channel posts generated" : `Option ${optionLabel} selected`);
  }

  async function handleRequestRevision() {
    if (!feedback.trim()) return;
    setPending(true);
    const res = await requestDraftRevision(viewed.id, feedback);
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Revision requested");
    setFeedback("");
    setShowFeedbackInput(false);
  }

  return (
    <div className="flex min-w-[320px] flex-1 flex-col gap-3 border border-rule p-4">
      <div className="flex items-center justify-between">
        <span className="font-sans text-xs font-semibold text-muted">Option {optionLabel}</span>
        {isSelected && <span className="stamp text-approve">selected</span>}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {sorted.map((v) => (
          <button
            key={v.id}
            onClick={() => {
              setViewedId(v.id);
              setMode("preview");
            }}
            className={`cursor-pointer rounded-[3px] border px-1.5 py-0.5 text-[10px] ${
              v.id === viewedId ? "border-ink text-ink" : "border-rule text-muted"
            }`}
            title={SOURCE_LABEL[v.revision_source]}
          >
            v{v.version}
          </button>
        ))}
      </div>

      {mode === "preview" ? (
        <>
          <h3 className="font-serif text-lg font-semibold">{viewed.title}</h3>
          {viewed.citedSourceUrls && viewed.citedSourceUrls.length > 0 && (
            <p className="text-xs text-muted">
              Sources cited: {viewed.citedSourceUrls.map((url, i) => (
                <span key={url}>
                  {i > 0 && ", "}
                  <a href={url} target="_blank" rel="noreferrer" className="underline">
                    {new URL(url).hostname}
                  </a>
                </span>
              ))}
            </p>
          )}
          <div className="max-h-96 overflow-y-auto">
            <ArticlePreview bodyMarkdown={viewed.body_markdown} flags={[...(evaluation?.unsupported_claims ?? []), ...(evaluation?.sections_needing_revision ?? [])]} />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <input
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            className="border border-rule px-2 py-1 font-serif text-lg"
          />
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            rows={14}
            className="border border-rule p-2 font-mono text-xs"
          />
          <div className="flex gap-2">
            <button onClick={handleSaveEdit} disabled={pending} className="cursor-pointer border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed">
              Save edit
            </button>
            <button onClick={() => setMode("preview")} className="cursor-pointer px-3 py-1 text-xs text-muted">
              Cancel
            </button>
          </div>
        </div>
      )}

      {evaluation && <EvaluationPanel evaluation={evaluation} />}

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-rule pt-3">
        <button
          onClick={() => handleSelect(viewed.id)}
          disabled={pending || (isSelected && hasChannelOutputs)}
          className="cursor-pointer border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSelected && !hasChannelOutputs ? "Retry channel generation" : "Select this option"}
        </button>
        {mode === "preview" && (
          <button onClick={startEdit} disabled={pending} className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed">
            Edit
          </button>
        )}
        <button
          onClick={() => setShowFeedbackInput(!showFeedbackInput)}
          disabled={pending}
          className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed"
        >
          Request AI revision
        </button>
      </div>

      {showFeedbackInput && (
        <div className="flex flex-col gap-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should change?"
            rows={2}
            className="border border-rule p-2 text-xs"
          />
          <button
            onClick={handleRequestRevision}
            disabled={pending || !feedback.trim()}
            className="cursor-pointer self-start border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
          >
            Submit feedback
          </button>
        </div>
      )}
    </div>
  );
}
