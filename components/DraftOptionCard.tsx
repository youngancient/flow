"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArticlePreview } from "./ArticlePreview";
import { EvaluationPanel, type EvaluationRow } from "./EvaluationPanel";
import { Modal } from "./Modal";
import { Spinner } from "./Spinner";
import { StatusBadge } from "./StatusBadge";
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
  switchBlockReason,
  isOwner,
}: {
  requestId: string;
  optionLabel: string;
  versions: DraftVersion[];
  evaluationsByDraftId: Record<string, EvaluationRow | undefined>;
  selectedDraftId: string | null;
  hasChannelOutputs: boolean;
  switchBlockReason: string | null;
  isOwner: boolean;
}) {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const latest = sorted[sorted.length - 1];
  const [viewedId, setViewedId] = useState(latest.id);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [feedback, setFeedback] = useState("");
  const [showFeedbackInput, setShowFeedbackInput] = useState(false);
  const [pendingAction, setPendingAction] = useState<"select" | "save" | "revise" | null>(null);
  const pending = pendingAction !== null;
  const [confirmSwitchDraftId, setConfirmSwitchDraftId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const editBodyRef = useRef<HTMLTextAreaElement>(null);

  const viewed = sorted.find((v) => v.id === viewedId) ?? latest;
  const evaluation = evaluationsByDraftId[viewed.id];
  const isSelected = selectedDraftId === viewed.id;
  // Only the selected option can be locked — a non-selected one is an inert
  // alternate, never tied to anything a manager is reviewing. switchBlockReason
  // reflects the exact same condition selectDraft's switch-guard uses.
  const editLocked = isSelected && Boolean(switchBlockReason);
  // Once a decision's been made, an unselected option collapses to a
  // one-line row (title + eval stamp + switch action) instead of competing
  // for the same space as the draft actually being worked on — "Show
  // preview" expands it back to the full card on demand.
  const isCollapsible = selectedDraftId !== null && !isSelected;
  const isCollapsed = isCollapsible && !expanded;

  // Grows/shrinks the edit textarea to fit its content, up to the same
  // max-height the preview view uses (max-h-96 = 384px) — beyond that it
  // scrolls internally instead of stretching the whole card (and the
  // 3-column layout) to match a full article's real length.
  const EDIT_BODY_MAX_HEIGHT = 384;
  useEffect(() => {
    const el = editBodyRef.current;
    if (mode === "edit" && el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, EDIT_BODY_MAX_HEIGHT)}px`;
    }
  }, [mode, editBody]);

  // Formatting toolbar — inserts the right markdown around the cursor/
  // selection so a non-technical editor never has to know the syntax
  // itself, just what "Bold" or "Heading" means.
  function wrapSelection(marker: string) {
    const el = editBodyRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = editBody.slice(start, end);
    const next = `${editBody.slice(0, start)}${marker}${selected}${marker}${editBody.slice(end)}`;
    setEditBody(next);
    requestAnimationFrame(() => {
      el.focus();
      if (selected.length > 0) {
        el.setSelectionRange(start + marker.length, end + marker.length);
      } else {
        const cursor = start + marker.length;
        el.setSelectionRange(cursor, cursor);
      }
    });
  }

  function setHeadingLevel(level: 2 | 3) {
    const el = editBodyRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const lineStart = editBody.lastIndexOf("\n", start - 1) + 1;
    const lineEndIdx = editBody.indexOf("\n", start);
    const lineEnd = lineEndIdx === -1 ? editBody.length : lineEndIdx;
    const line = editBody.slice(lineStart, lineEnd);
    const withoutMarker = line.replace(/^#{1,6}\s*/, "");
    const newLine = `${"#".repeat(level)} ${withoutMarker}`;
    const next = editBody.slice(0, lineStart) + newLine + editBody.slice(lineEnd);
    setEditBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const cursor = lineStart + newLine.length;
      el.setSelectionRange(cursor, cursor);
    });
  }

  function toggleBulletList() {
    const el = editBodyRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const lineStart = editBody.lastIndexOf("\n", start - 1) + 1;
    const lineEndIdx = editBody.indexOf("\n", end);
    const lineEnd = lineEndIdx === -1 ? editBody.length : lineEndIdx;
    const block = editBody.slice(lineStart, lineEnd);
    const alreadyBulleted = block.split("\n").every((line) => line.startsWith("- ") || line.trim() === "");
    const transformed = block
      .split("\n")
      .map((line) => {
        if (line.trim() === "") return line;
        return alreadyBulleted ? line.replace(/^- /, "") : line.startsWith("- ") ? line : `- ${line}`;
      })
      .join("\n");
    const next = editBody.slice(0, lineStart) + transformed + editBody.slice(lineEnd);
    setEditBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(lineStart, lineStart + transformed.length);
    });
  }

  function startEdit() {
    setEditTitle(viewed.title);
    setEditBody(viewed.body_markdown);
    setMode("edit");
  }

  async function handleSaveEdit() {
    setPendingAction("save");
    const res = await editDraft(viewed.id, { title: editTitle, bodyMarkdown: editBody });
    setPendingAction(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Edit saved as a new version");
    setMode("preview");
  }

  async function performSelect(draftId: string) {
    const retrying = isSelected && !hasChannelOutputs;
    const isSwitching = hasChannelOutputs && !isSelected;

    setPendingAction("select");
    const res = await selectDraft(requestId, draftId);
    setPendingAction(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(retrying ? "Channel posts generated" : isSwitching ? "Draft switched, channels regenerated" : `Option ${optionLabel} selected`);
  }

  function handleSelect(draftId: string) {
    const isSwitching = hasChannelOutputs && !isSelected;
    if (isSwitching) {
      if (switchBlockReason) {
        toast.error(switchBlockReason);
        return;
      }
      setConfirmSwitchDraftId(draftId);
      return;
    }
    performSelect(draftId);
  }

  async function confirmSwitchAndSelect() {
    if (!confirmSwitchDraftId) return;
    const draftId = confirmSwitchDraftId;
    setConfirmSwitchDraftId(null);
    await performSelect(draftId);
  }

  async function handleRequestRevision() {
    if (!feedback.trim()) return;
    setPendingAction("revise");
    const res = await requestDraftRevision(viewed.id, feedback);
    setPendingAction(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Revision requested");
    setFeedback("");
    setShowFeedbackInput(false);
  }

  const confirmSwitchModal = confirmSwitchDraftId && (
    <Modal title="Switch draft?" onClose={() => setConfirmSwitchDraftId(null)}>
      <p className="text-sm">
        This request already has LinkedIn, X, and newsletter content. Switching to this draft will regenerate all three from scratch and clear any existing approvals.
      </p>
      <div className="flex items-center gap-2 pt-2">
        <button
          onClick={confirmSwitchAndSelect}
          disabled={pending}
          className="inline-flex cursor-pointer items-center gap-1.5 border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pendingAction === "select" && <Spinner />}
          {pendingAction === "select" ? "Switching…" : "Continue"}
        </button>
        <button
          onClick={() => setConfirmSwitchDraftId(null)}
          disabled={pending}
          className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed"
        >
          Cancel
        </button>
      </div>
    </Modal>
  );

  if (isCollapsed) {
    return (
      <div className="flex min-w-[320px] flex-1 flex-col gap-2 border border-rule p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 overflow-hidden">
            <span className="shrink-0 font-sans text-xs font-semibold text-muted">Option {optionLabel}</span>
            <span className="truncate text-sm">{latest.title}</span>
          </div>
          {evaluation && <StatusBadge status={evaluation.overall_status} />}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setExpanded(true)} className="cursor-pointer text-xs text-muted underline hover:text-ink">
            Show preview
          </button>
          {isOwner && (
            <button
              onClick={() => handleSelect(latest.id)}
              disabled={pending}
              title={switchBlockReason ?? undefined}
              className="inline-flex cursor-pointer items-center gap-1.5 border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed"
            >
              {pendingAction === "select" && <Spinner />}
              {pendingAction === "select" ? "Switching…" : "Switch to this"}
            </button>
          )}
        </div>

        {confirmSwitchModal}
      </div>
    );
  }

  return (
    <div className="flex min-w-[320px] flex-1 flex-col gap-3 border border-rule p-4">
      <div className="flex items-center justify-between">
        <span className="font-sans text-xs font-semibold text-muted">Option {optionLabel}</span>
        <div className="flex items-center gap-2">
          {isSelected && <span className="stamp text-approve">selected</span>}
          {isCollapsible && (
            <button onClick={() => setExpanded(false)} className="cursor-pointer text-xs text-muted underline hover:text-ink">
              Hide preview
            </button>
          )}
        </div>
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
            disabled={pending}
            className="border border-rule px-2 py-1 font-serif text-lg disabled:opacity-60"
          />
          <div className="flex gap-1">
            <button type="button" title="Bold" onClick={() => wrapSelection("**")} disabled={pending} className="cursor-pointer border border-rule px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed">
              B
            </button>
            <button type="button" title="Italic" onClick={() => wrapSelection("*")} disabled={pending} className="cursor-pointer border border-rule px-2 py-1 text-xs italic disabled:cursor-not-allowed">
              I
            </button>
            <button type="button" title="Heading 2" onClick={() => setHeadingLevel(2)} disabled={pending} className="cursor-pointer border border-rule px-2 py-1 text-xs disabled:cursor-not-allowed">
              H2
            </button>
            <button type="button" title="Heading 3" onClick={() => setHeadingLevel(3)} disabled={pending} className="cursor-pointer border border-rule px-2 py-1 text-xs disabled:cursor-not-allowed">
              H3
            </button>
            <button type="button" title="Bullet list" onClick={toggleBulletList} disabled={pending} className="cursor-pointer border border-rule px-2 py-1 text-xs disabled:cursor-not-allowed">
              •
            </button>
          </div>
          <textarea
            ref={editBodyRef}
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            rows={4}
            disabled={pending}
            className="resize-none overflow-y-auto border border-rule p-2 font-mono text-xs disabled:opacity-60"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSaveEdit}
              disabled={pending}
              className="inline-flex cursor-pointer items-center gap-1.5 border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed"
            >
              {pendingAction === "save" && <Spinner />}
              {pendingAction === "save" ? "Saving…" : "Save edit"}
            </button>
            <button onClick={() => setMode("preview")} disabled={pending} className="cursor-pointer px-3 py-1 text-xs text-muted disabled:cursor-not-allowed">
              Cancel
            </button>
          </div>
        </div>
      )}

      {evaluation && <EvaluationPanel evaluation={evaluation} />}

      {isOwner && (
        <>
          <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-rule pt-3">
            <button
              onClick={() => handleSelect(viewed.id)}
              disabled={pending || (isSelected && hasChannelOutputs)}
              className="inline-flex cursor-pointer items-center gap-1.5 border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pendingAction === "select" && <Spinner />}
              {pendingAction === "select"
                ? isSelected && !hasChannelOutputs
                  ? "Retrying…"
                  : "Selecting…"
                : isSelected && !hasChannelOutputs
                  ? `Retry channel generation (v${viewed.version})`
                  : `Select this option (v${viewed.version})`}
            </button>
            {mode === "preview" && !editLocked && (
              <button onClick={startEdit} disabled={pending} className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed">
                Edit
              </button>
            )}
            {!editLocked && (
              <button
                onClick={() => setShowFeedbackInput(!showFeedbackInput)}
                disabled={pending}
                className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed"
              >
                Request AI revision
              </button>
            )}
          </div>

          {editLocked && <p className="text-xs text-muted">{switchBlockReason}</p>}

          {!editLocked && showFeedbackInput && (
            <div className="flex flex-col gap-2">
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="What should change?"
                rows={2}
                disabled={pending}
                className="border border-rule p-2 text-xs disabled:opacity-60"
              />
              <button
                onClick={handleRequestRevision}
                disabled={pending || !feedback.trim()}
                className="inline-flex cursor-pointer items-center gap-1.5 self-start border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pendingAction === "revise" && <Spinner />}
                {pendingAction === "revise" ? "Submitting…" : "Submit feedback"}
              </button>
            </div>
          )}
        </>
      )}

      {confirmSwitchModal}
    </div>
  );
}
