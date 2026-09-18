import Link from "next/link";
import { supabaseService } from "@/lib/supabase/service";
import { requireSessionEmailOrRedirect } from "@/lib/supabase/auth";
import { getSubscriberPreview, type SubscriberPreview } from "@/lib/brevo";
import { QueueTable, type QueueRow } from "@/components/QueueTable";
import { SubscriberList } from "@/components/SubscriberList";
import { ThemeToggle } from "@/components/ThemeToggle";

export const dynamic = "force-dynamic"; // always-fresh queue state, never statically cached

export default async function QueuePage() {
  await requireSessionEmailOrRedirect(); // no route is reachable by an unauthenticated request — see artifact/design.md, "Authentication"
  const db = supabaseService();

  let subscriberPreview: SubscriberPreview | null = null;
  let subscriberError: string | null = null;
  try {
    subscriberPreview = await getSubscriberPreview();
  } catch (err) {
    subscriberError = err instanceof Error ? err.message : "Could not load subscribers from Brevo";
  }
  const { data } = await db
    .from("channel_outputs")
    .select("id, request_id, channel, subject, publish_status, scheduled_for, sent_at, last_error, content_requests(raw_idea)")
    .neq("publish_status", "not_queued")
    .order("updated_at", { ascending: false });

  const rows: QueueRow[] = (data ?? []).map((row) => {
    const request = Array.isArray(row.content_requests) ? row.content_requests[0] : row.content_requests;
    return {
      id: row.id,
      request_id: row.request_id,
      raw_idea: request?.raw_idea ?? "",
      channel: row.channel,
      subject: row.subject,
      publish_status: row.publish_status,
      scheduled_for: row.scheduled_for,
      sent_at: row.sent_at,
      last_error: row.last_error,
    };
  });

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-sm text-muted underline">
          ← Home
        </Link>
        <ThemeToggle />
      </div>
      <h1 className="font-serif text-2xl">Publishing queue</h1>
      <section className="flex flex-col gap-2 border-b border-rule pb-6">
        <h2 className="text-xs font-semibold text-muted">Newsletter subscribers</h2>
        <p className="text-xs text-muted">
          Managed directly in the{" "}
          <a href="https://app.brevo.com" target="_blank" rel="noreferrer" className="underline">
            Brevo dashboard
          </a>{" "}
          (add contacts, import a CSV export, or remove someone); sending here always targets that list. This is a
          read-only preview, not a management view.
        </p>
        {subscriberError ? (
          <p className="text-xs text-flag">{subscriberError}</p>
        ) : (
          subscriberPreview && <SubscriberList preview={subscriberPreview} />
        )}
      </section>
      <QueueTable rows={rows} />
    </main>
  );
}
