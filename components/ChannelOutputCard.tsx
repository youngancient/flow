"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StatusBadge } from "./StatusBadge";
import { LocalTime } from "./LocalTime";
import { Modal } from "./Modal";
import { LinkedInPreview } from "./LinkedInPreview";
import { XPreview } from "./XPreview";
import { NewsletterPreview } from "./NewsletterPreview";
import { Spinner } from "./Spinner";
import { X_CHAR_LIMIT, xPostCharCount } from "@/lib/rules";
import {
  approveChannelOutput,
  rejectChannelOutput,
  requestChannelOutputChanges,
  unapproveChannelOutput,
  regenerateChannelOutput,
  saveChannelOutputEdit,
  resubmitChannelOutput,
  markSocialPosted,
  scheduleSocialPost,
  cancelScheduledSocialPost,
} from "@/app/requests/[id]/actions";

/** Formats an ISO timestamp as a `datetime-local` input value, in the viewer's local time. */
function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type ChannelOutput = {
  id: string;
  channel: "linkedin" | "x" | "newsletter";
  subject: string | null;
  body: string;
  hashtags: string[];
  review_status: "draft" | "pending_review" | "approved" | "rejected" | "changes_requested";
  review_comment: string | null;
  reviewed_by: string | null;
  publish_status: "not_queued" | "queued" | "scheduled" | "sending" | "sent" | "failed";
  scheduled_for: string | null;
  sent_at: string | null;
  last_error: string | null;
};

const CHANNEL_LABEL: Record<ChannelOutput["channel"], string> = {
  linkedin: "LinkedIn",
  x: "X",
  newsletter: "Newsletter",
};

// Not 'pending_review': once it's been sent for approval, it's out of the
// owner's hands until a manager decides — same rule selectDraft's switch
// guard already enforces (lib/publishStatus.ts's describeSwitchDraftBlock).
const EDITABLE_STATUSES: ChannelOutput["review_status"][] = ["draft", "rejected", "changes_requested"];

export function ChannelOutputCard({
  output,
  isOwner,
  isManager,
  viewerEmail,
}: {
  output: ChannelOutput;
  isOwner: boolean;
  isManager: boolean;
  viewerEmail: string;
}) {
  const router = useRouter();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [body, setBody] = useState(output.body);
  const [subject, setSubject] = useState(output.subject ?? "");
  // Stripped here too, not just on typed input — a stored hashtag that
  // already has a "#" baked in (the model isn't consistent about leaving
  // it out) would otherwise show up literally in the edit field even
  // before the user touches anything.
  const [hashtagsInput, setHashtagsInput] = useState(output.hashtags.map((h) => h.replace(/^#+/, "")).join(", "));
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [changesComment, setChangesComment] = useState("");
  const [showChangesInput, setShowChangesInput] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [rescheduling, setRescheduling] = useState(false);
  type PendingAction =
    | "approve"
    | "reject"
    | "requestChanges"
    | "unapprove"
    | "regenerate"
    | "save"
    | "resubmit"
    | "markPosted"
    | "schedule"
    | "cancelSchedule"
    | "send"
    | null;
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const pending = pendingAction !== null;
  const canEdit = isOwner && EDITABLE_STATUSES.includes(output.review_status);
  const typedHashtags = hashtagsInput
    .split(",")
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);
  const parsedHashtags = typedHashtags.slice(0, 2);
  const hasExtraHashtags = typedHashtags.length > 2;
  const originalHashtags = output.hashtags.map((h) => h.replace(/^#+/, ""));
  const isDirty =
    body !== output.body ||
    subject !== (output.subject ?? "") ||
    (output.channel === "x" && JSON.stringify(parsedHashtags) !== JSON.stringify(originalHashtags));

  function toggleReschedule() {
    if (!rescheduling && output.scheduled_for) {
      setScheduleAt(toDatetimeLocalValue(output.scheduled_for));
    }
    setRescheduling(!rescheduling);
  }

  async function withPending(action: PendingAction, fn: () => Promise<void>) {
    setPendingAction(action);
    try {
      await fn();
    } finally {
      setPendingAction(null);
    }
  }

  async function handleApprove() {
    await withPending("approve", async () => {
      const res = await approveChannelOutput(output.id);
      if (!res.ok) toast.error(res.error);
      else toast.success(`${CHANNEL_LABEL[output.channel]} approved`);
    });
  }

  async function handleReject() {
    if (!rejectNote.trim()) return;
    await withPending("reject", async () => {
      const res = await rejectChannelOutput(output.id, rejectNote);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`${CHANNEL_LABEL[output.channel]} rejected`);
        setRejectNote("");
        setShowRejectInput(false);
      }
    });
  }

  async function handleRequestChanges() {
    if (!changesComment.trim()) return;
    await withPending("requestChanges", async () => {
      const res = await requestChannelOutputChanges(output.id, changesComment);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`Requested changes on ${CHANNEL_LABEL[output.channel]}`);
        setChangesComment("");
        setShowChangesInput(false);
      }
    });
  }

  async function handleCopy() {
    // Matches exactly what each platform's preview renders — hashtags
    // appended the same way XPreview shows them, subject prefixed for the
    // newsletter since that's a real part of what gets sent.
    const text =
      output.channel === "x"
        ? [body, parsedHashtags.map((h) => `#${h}`).join(" ")].filter(Boolean).join(" ")
        : output.channel === "newsletter"
          ? `Subject: ${subject}\n\n${body}`
          : body;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Couldn't copy — your browser may be blocking clipboard access");
    }
  }

  async function handleSave() {
    await withPending("save", async () => {
      const res = await saveChannelOutputEdit(output.id, {
        body,
        subject: output.channel === "newsletter" ? subject : undefined,
        hashtags: output.channel === "x" ? parsedHashtags : undefined,
      });
      if (!res.ok) toast.error(res.error);
      else toast.success("Saved");
    });
  }

  async function handleResubmit() {
    await withPending("resubmit", async () => {
      const res = await resubmitChannelOutput(output.id);
      if (!res.ok) toast.error(res.error);
      else toast.success(`${CHANNEL_LABEL[output.channel]} sent back for review`);
    });
  }

  async function handleUnapprove() {
    await withPending("unapprove", async () => {
      const res = await unapproveChannelOutput(output.id);
      if (!res.ok) toast.error(res.error);
      else toast.success(`${CHANNEL_LABEL[output.channel]} unapproved`);
    });
  }

  async function handleRegenerate() {
    await withPending("regenerate", async () => {
      const res = await regenerateChannelOutput(output.id, feedback || undefined);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`${CHANNEL_LABEL[output.channel]} regenerated`);
        setFeedback("");
        setShowFeedback(false);
      }
    });
  }

  async function handleMarkPosted() {
    await withPending("markPosted", async () => {
      const res = await markSocialPosted(output.id);
      if (!res.ok) toast.error(res.error);
      else toast.success("Marked posted");
    });
  }

  async function handleScheduleSocial() {
    if (!scheduleAt) return;
    await withPending("schedule", async () => {
      const res = await scheduleSocialPost(output.id, new Date(scheduleAt).toISOString());
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Scheduled");
        setRescheduling(false);
        setScheduleAt("");
      }
    });
  }

  async function handleCancelScheduleSocial() {
    await withPending("cancelSchedule", async () => {
      const res = await cancelScheduledSocialPost(output.id);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Schedule canceled");
        setRescheduling(false);
        setScheduleAt("");
      }
    });
  }

  async function handleSendNewsletterNow() {
    await withPending("send", async () => {
      const res = await fetch(`/api/publish/newsletter/${output.id}/send`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) {
        toast.error(json.error ?? "Send failed");
      } else {
        toast.success("Newsletter sent");
        router.refresh();
      }
    });
  }

  async function handleScheduleNewsletter() {
    if (!scheduleAt) return;
    await withPending("schedule", async () => {
      const res = await fetch(`/api/publish/newsletter/${output.id}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledFor: new Date(scheduleAt).toISOString() }),
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error(json.error ?? "Schedule failed");
      } else {
        toast.success("Scheduled");
        setRescheduling(false);
        setScheduleAt("");
        router.refresh();
      }
    });
  }

  async function handleCancelScheduleNewsletter() {
    await withPending("cancelSchedule", async () => {
      const res = await fetch(`/api/publish/newsletter/${output.id}/cancel`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) {
        toast.error(json.error ?? "Failed to cancel schedule");
      } else {
        toast.success("Schedule canceled");
        setRescheduling(false);
        setScheduleAt("");
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 border border-rule p-4">
      <div className="flex items-center justify-between">
        <span className="font-sans text-xs font-semibold text-muted">{CHANNEL_LABEL[output.channel]}</span>
        <div className="flex gap-1.5">
          <StatusBadge status={output.review_status} />
          {output.publish_status !== "not_queued" && <StatusBadge status={output.publish_status} />}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {output.channel === "newsletter" && (
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={!canEdit || pending}
            className="border border-rule px-2 py-1 text-sm disabled:opacity-60"
          />
        )}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          disabled={!canEdit || pending}
          className="border border-rule p-2 text-sm disabled:opacity-60"
        />
        {output.channel === "x" && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`hashtags-${output.id}`} className="text-xs text-muted">
              Hashtags
            </label>
            <div className="flex items-center gap-2">
              <input
                id={`hashtags-${output.id}`}
                value={hashtagsInput}
                onChange={(e) => setHashtagsInput(e.target.value)}
                disabled={!canEdit || pending}
                placeholder="up to 2, comma separated, e.g. ai, startups"
                className="flex-1 border border-rule px-2 py-1 text-sm disabled:opacity-60"
              />
              <span className={`text-xs ${xPostCharCount(body, parsedHashtags) > X_CHAR_LIMIT ? "text-flag" : "text-muted"}`}>
                {xPostCharCount(body, parsedHashtags)}/{X_CHAR_LIMIT}
              </span>
            </div>
            {hasExtraHashtags && <p className="text-xs text-flag">Only the first 2 will be saved: {parsedHashtags.join(", ")}</p>}
          </div>
        )}
        <div className="flex items-center gap-3">
          <button onClick={() => setPreviewOpen(true)} className="cursor-pointer text-xs text-muted underline hover:text-ink">
            Preview
          </button>
          <button onClick={handleCopy} className="cursor-pointer text-xs text-muted underline hover:text-ink">
            Copy
          </button>
        </div>
      </div>

      {previewOpen && (
        <Modal title={`${CHANNEL_LABEL[output.channel]} preview`} onClose={() => setPreviewOpen(false)}>
          {output.channel === "linkedin" ? (
            <LinkedInPreview body={body} />
          ) : output.channel === "x" ? (
            <XPreview body={body} hashtags={parsedHashtags} />
          ) : (
            <NewsletterPreview subject={subject} body={body} />
          )}
        </Modal>
      )}

      {output.last_error && <p className="text-xs text-flag">{output.last_error}</p>}

      {(output.review_status === "rejected" || output.review_status === "changes_requested") && output.review_comment && (
        <p className="text-xs text-pending">
          {output.reviewed_by === viewerEmail ? "You" : output.reviewed_by ?? "A manager"}{" "}
          {output.review_status === "rejected" ? "rejected this" : "asked for changes"}: {output.review_comment}
        </p>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
          <button
            onClick={handleSave}
            disabled={pending || !isDirty}
            className="inline-flex cursor-pointer items-center gap-1.5 border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pendingAction === "save" && <Spinner />}
            {pendingAction === "save" ? "Saving…" : "Save"}
          </button>
          <button onClick={() => setShowFeedback(!showFeedback)} disabled={pending} className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed">
            Regenerate
          </button>
        </div>
      )}

      {isOwner && (output.review_status === "rejected" || output.review_status === "changes_requested") && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleResubmit}
            disabled={pending || isDirty}
            title={isDirty ? "Save your edit first" : undefined}
            className="inline-flex cursor-pointer items-center gap-1.5 border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pendingAction === "resubmit" && <Spinner />}
            {pendingAction === "resubmit" ? "Sending…" : "Resend for review"}
          </button>
        </div>
      )}

      {canEdit && showFeedback && (
        <div className="flex flex-col gap-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            placeholder="What should change?"
            disabled={pending}
            className="border border-rule p-2 text-xs disabled:opacity-60"
          />
          <button
            onClick={handleRegenerate}
            disabled={pending}
            className="inline-flex cursor-pointer items-center gap-1.5 self-start border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed"
          >
            {pendingAction === "regenerate" && <Spinner />}
            {pendingAction === "regenerate" ? "Regenerating…" : "Regenerate with feedback"}
          </button>
        </div>
      )}

      {isManager && !isOwner && output.review_status === "pending_review" && (
        <div className="flex flex-col gap-2 border-t border-rule pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={handleApprove} disabled={pending} className="inline-flex cursor-pointer items-center gap-1.5 border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed">
              {pendingAction === "approve" && <Spinner />}
              {pendingAction === "approve" ? "Approving…" : "Approve"}
            </button>
            <button onClick={() => setShowChangesInput(!showChangesInput)} disabled={pending} className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed">
              Request changes
            </button>
            <button onClick={() => setShowRejectInput(!showRejectInput)} disabled={pending} className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed">
              Reject
            </button>
          </div>
          {showChangesInput && (
            <div className="flex flex-col gap-2">
              <textarea
                value={changesComment}
                onChange={(e) => setChangesComment(e.target.value)}
                rows={2}
                placeholder="What should the requester change?"
                disabled={pending}
                className="border border-rule p-2 text-xs disabled:opacity-60"
              />
              <button
                onClick={handleRequestChanges}
                disabled={pending || !changesComment.trim()}
                className="inline-flex cursor-pointer items-center gap-1.5 self-start border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pendingAction === "requestChanges" && <Spinner />}
                {pendingAction === "requestChanges" ? "Sending…" : "Submit"}
              </button>
            </div>
          )}
          {showRejectInput && (
            <div className="flex flex-col gap-2">
              <textarea
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                rows={2}
                placeholder="Why is this rejected?"
                disabled={pending}
                className="border border-rule p-2 text-xs disabled:opacity-60"
              />
              <button
                onClick={handleReject}
                disabled={pending || !rejectNote.trim()}
                className="inline-flex cursor-pointer items-center gap-1.5 self-start border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pendingAction === "reject" && <Spinner />}
                {pendingAction === "reject" ? "Rejecting…" : "Confirm reject"}
              </button>
            </div>
          )}
        </div>
      )}

      {isManager && !isOwner && output.review_status === "approved" && output.publish_status !== "sent" && output.publish_status !== "scheduled" && (
        <div className="border-t border-rule pt-3">
          <button
            onClick={handleUnapprove}
            disabled={pending}
            className="inline-flex cursor-pointer items-center gap-1.5 border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed"
          >
            {pendingAction === "unapprove" && <Spinner />}
            {pendingAction === "unapprove" ? "Unapproving…" : "Unapprove"}
          </button>
        </div>
      )}

      {isOwner && output.review_status === "approved" && output.publish_status !== "sent" && (
        <div className="flex flex-col gap-2 border-t border-rule pt-3">
          {output.publish_status === "scheduled" ? (
            <>
              <p className="text-xs text-muted">
                Scheduled for {output.scheduled_for ? <LocalTime iso={output.scheduled_for} withTime /> : "—"}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={toggleReschedule} disabled={pending} className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed">
                  Reschedule
                </button>
                <button
                  onClick={output.channel === "newsletter" ? handleCancelScheduleNewsletter : handleCancelScheduleSocial}
                  disabled={pending}
                  className="inline-flex cursor-pointer items-center gap-1.5 border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed"
                >
                  {pendingAction === "cancelSchedule" && <Spinner />}
                  {pendingAction === "cancelSchedule" ? "Canceling…" : "Cancel schedule"}
                </button>
              </div>
              {rescheduling && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={(e) => setScheduleAt(e.target.value)}
                    onClick={(e) => e.currentTarget.showPicker?.()}
                    className="cursor-pointer border border-rule px-2 py-1 text-xs"
                  />
                  <button
                    onClick={output.channel === "newsletter" ? handleScheduleNewsletter : handleScheduleSocial}
                    disabled={pending || !scheduleAt}
                    className="inline-flex cursor-pointer items-center gap-1.5 border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed"
                  >
                    {pendingAction === "schedule" && <Spinner />}
                    {pendingAction === "schedule" ? "Saving…" : "Save new time"}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-start gap-2">
              {output.channel === "newsletter" ? (
                <button
                  onClick={handleSendNewsletterNow}
                  disabled={pending}
                  className="inline-flex cursor-pointer items-center gap-1.5 border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed"
                >
                  {pendingAction === "send" && <Spinner />}
                  {pendingAction === "send" ? "Sending…" : "Send now"}
                </button>
              ) : (
                <button
                  onClick={handleMarkPosted}
                  disabled={pending}
                  className="inline-flex cursor-pointer items-center gap-1.5 border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed"
                >
                  {pendingAction === "markPosted" && <Spinner />}
                  {pendingAction === "markPosted" ? "Marking…" : "Mark posted"}
                </button>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  onClick={(e) => e.currentTarget.showPicker?.()}
                  className="cursor-pointer border border-rule px-2 py-1 text-xs"
                />
                <button
                  onClick={output.channel === "newsletter" ? handleScheduleNewsletter : handleScheduleSocial}
                  disabled={pending || !scheduleAt}
                  className="inline-flex cursor-pointer items-center gap-1.5 border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed"
                >
                  {pendingAction === "schedule" && <Spinner />}
                  {pendingAction === "schedule" ? "Scheduling…" : "Schedule"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
