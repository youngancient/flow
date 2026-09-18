"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StatusBadge } from "./StatusBadge";
import { Modal } from "./Modal";
import { LinkedInPreview } from "./LinkedInPreview";
import { XPreview } from "./XPreview";
import { NewsletterPreview } from "./NewsletterPreview";
import { Spinner } from "./Spinner";
import { formatDateTime } from "@/lib/format";
import {
  approveChannelOutput,
  rejectChannelOutput,
  unapproveChannelOutput,
  regenerateChannelOutput,
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
  review_status: "pending_review" | "approved" | "rejected";
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

export function ChannelOutputCard({ output, isOwner }: { output: ChannelOutput; isOwner: boolean }) {
  const router = useRouter();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [body, setBody] = useState(output.body);
  const [subject, setSubject] = useState(output.subject ?? "");
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [rescheduling, setRescheduling] = useState(false);
  type PendingAction = "approve" | "reject" | "unapprove" | "regenerate" | "markPosted" | "schedule" | "cancelSchedule" | "send" | null;
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const pending = pendingAction !== null;

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
      const res = await approveChannelOutput(output.id, body !== output.body ? body : undefined);
      if (!res.ok) toast.error(res.error);
      else toast.success(`${CHANNEL_LABEL[output.channel]} approved`);
    });
  }

  async function handleReject() {
    await withPending("reject", async () => {
      const res = await rejectChannelOutput(output.id);
      if (!res.ok) toast.error(res.error);
      else toast.success(`${CHANNEL_LABEL[output.channel]} rejected`);
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
            disabled={!isOwner}
            className="border border-rule px-2 py-1 text-sm disabled:opacity-60"
          />
        )}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          disabled={!isOwner}
          className="border border-rule p-2 text-sm disabled:opacity-60"
        />
        <button onClick={() => setPreviewOpen(true)} className="cursor-pointer self-start text-xs text-muted underline hover:text-ink">
          Preview
        </button>
      </div>

      {previewOpen && (
        <Modal title={`${CHANNEL_LABEL[output.channel]} preview`} onClose={() => setPreviewOpen(false)}>
          {output.channel === "linkedin" ? (
            <LinkedInPreview body={body} />
          ) : output.channel === "x" ? (
            <XPreview body={body} hashtags={output.hashtags} />
          ) : (
            <NewsletterPreview subject={subject} body={body} />
          )}
        </Modal>
      )}

      {output.last_error && <p className="text-xs text-flag">{output.last_error}</p>}

      {isOwner && (output.review_status === "pending_review" || output.review_status === "rejected") && (
        <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
          <button onClick={handleApprove} disabled={pending} className="inline-flex cursor-pointer items-center gap-1.5 border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed">
            {pendingAction === "approve" && <Spinner />}
            {pendingAction === "approve" ? "Approving…" : "Approve"}
          </button>
          {output.review_status === "pending_review" && (
            <button onClick={handleReject} disabled={pending} className="inline-flex cursor-pointer items-center gap-1.5 border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed">
              {pendingAction === "reject" && <Spinner />}
              {pendingAction === "reject" ? "Rejecting…" : "Reject"}
            </button>
          )}
          <button onClick={() => setShowFeedback(!showFeedback)} disabled={pending} className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed">
            Regenerate
          </button>
        </div>
      )}

      {isOwner && showFeedback && (
        <div className="flex flex-col gap-2">
          <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} placeholder="What should change?" className="border border-rule p-2 text-xs" />
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

      {isOwner && output.review_status === "approved" && output.publish_status !== "sent" && (
        <div className="flex flex-col gap-2 border-t border-rule pt-3">
          {output.publish_status === "scheduled" ? (
            <>
              <p className="text-xs text-muted">
                Scheduled for {output.scheduled_for ? formatDateTime(output.scheduled_for) : "—"}
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
        </div>
      )}
    </div>
  );
}
