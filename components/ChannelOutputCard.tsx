"use client";

import { useState } from "react";
import { toast } from "sonner";
import { StatusBadge } from "./StatusBadge";
import { LinkedInPreview } from "./LinkedInPreview";
import { XPreview } from "./XPreview";
import { NewsletterPreview } from "./NewsletterPreview";
import {
  approveChannelOutput,
  rejectChannelOutput,
  regenerateChannelOutput,
  markSocialPosted,
  scheduleSocialPost,
} from "@/app/requests/[id]/actions";

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

export function ChannelOutputCard({ output }: { output: ChannelOutput }) {
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [body, setBody] = useState(output.body);
  const [subject, setSubject] = useState(output.subject ?? "");
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [pending, setPending] = useState(false);

  async function withPending(fn: () => Promise<void>) {
    setPending(true);
    try {
      await fn();
    } finally {
      setPending(false);
    }
  }

  async function handleApprove() {
    await withPending(async () => {
      const res = await approveChannelOutput(output.id, body !== output.body ? body : undefined);
      if (!res.ok) toast.error(res.error);
      else toast.success(`${CHANNEL_LABEL[output.channel]} approved`);
    });
  }

  async function handleReject() {
    await withPending(async () => {
      const res = await rejectChannelOutput(output.id);
      if (!res.ok) toast.error(res.error);
      else toast.success(`${CHANNEL_LABEL[output.channel]} rejected`);
    });
  }

  async function handleRegenerate() {
    await withPending(async () => {
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
    await withPending(async () => {
      const res = await markSocialPosted(output.id);
      if (!res.ok) toast.error(res.error);
      else toast.success("Marked posted");
    });
  }

  async function handleScheduleSocial() {
    if (!scheduleAt) return;
    await withPending(async () => {
      const res = await scheduleSocialPost(output.id, new Date(scheduleAt).toISOString());
      if (!res.ok) toast.error(res.error);
      else toast.success("Scheduled");
    });
  }

  async function handleSendNewsletterNow() {
    await withPending(async () => {
      const res = await fetch(`/api/publish/newsletter/${output.id}/send`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) toast.error(json.error ?? "Send failed");
      else toast.success("Newsletter sent");
    });
  }

  async function handleScheduleNewsletter() {
    if (!scheduleAt) return;
    await withPending(async () => {
      const res = await fetch(`/api/publish/newsletter/${output.id}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledFor: new Date(scheduleAt).toISOString() }),
      });
      const json = await res.json();
      if (!json.ok) toast.error(json.error ?? "Schedule failed");
      else toast.success("Scheduled");
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

      <div className="flex gap-1.5 text-xs">
        <button onClick={() => setMode("edit")} className={`cursor-pointer ${mode === "edit" ? "font-semibold underline" : "text-muted"}`}>
          Edit
        </button>
        <span className="text-muted">/</span>
        <button onClick={() => setMode("preview")} className={`cursor-pointer ${mode === "preview" ? "font-semibold underline" : "text-muted"}`}>
          Preview
        </button>
      </div>

      {mode === "edit" ? (
        <div className="flex flex-col gap-2">
          {output.channel === "newsletter" && (
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className="border border-rule px-2 py-1 text-sm" />
          )}
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className="border border-rule p-2 text-sm" />
        </div>
      ) : output.channel === "linkedin" ? (
        <LinkedInPreview body={body} />
      ) : output.channel === "x" ? (
        <XPreview body={body} hashtags={output.hashtags} />
      ) : (
        <NewsletterPreview subject={subject} body={body} />
      )}

      {output.last_error && <p className="text-xs text-flag">{output.last_error}</p>}

      {output.review_status === "pending_review" && (
        <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
          <button onClick={handleApprove} disabled={pending} className="cursor-pointer border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed">
            Approve
          </button>
          <button onClick={handleReject} disabled={pending} className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed">
            Reject
          </button>
          <button onClick={() => setShowFeedback(!showFeedback)} disabled={pending} className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed">
            Regenerate
          </button>
        </div>
      )}

      {showFeedback && (
        <div className="flex flex-col gap-2">
          <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} placeholder="What should change?" className="border border-rule p-2 text-xs" />
          <button onClick={handleRegenerate} disabled={pending} className="cursor-pointer self-start border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed">
            Regenerate with feedback
          </button>
        </div>
      )}

      {output.review_status === "approved" && output.publish_status !== "sent" && (
        <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
          {output.channel === "newsletter" ? (
            <>
              <button onClick={handleSendNewsletterNow} disabled={pending} className="cursor-pointer border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed">
                Send now
              </button>
              <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className="border border-rule px-2 py-1 text-xs" />
              <button onClick={handleScheduleNewsletter} disabled={pending || !scheduleAt} className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed">
                Schedule
              </button>
            </>
          ) : (
            <>
              <button onClick={handleMarkPosted} disabled={pending} className="cursor-pointer border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed">
                Mark posted
              </button>
              <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className="border border-rule px-2 py-1 text-xs" />
              <button onClick={handleScheduleSocial} disabled={pending || !scheduleAt} className="cursor-pointer border border-rule px-3 py-1 text-xs disabled:cursor-not-allowed">
                Schedule (label only)
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
