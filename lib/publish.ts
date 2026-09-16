import "server-only";
import { brevo, brevoSender, brevoListId } from "./brevo";
import { supabaseService } from "./supabase/service";
import { assertOk } from "./supabase/assert";
import { notifyNewsletterSent } from "./notify";

export type SendResult =
  | { status: "sent" }
  | { status: "skipped_already_claimed" }
  | { status: "failed"; error: string };

/**
 * Double-send guard: a compare-and-swap update claims the row before the
 * real send happens. If a duplicate click or a concurrent cron tick
 * already claimed it, zero rows come back and we skip — see
 * artifact/design.md, the channel_outputs "Double-send guard" note.
 * Sends via a Brevo Email Campaign against the real subscriber list
 * (BREVO_LIST_ID) rather than a static recipient array — see
 * "Notifications" and the subscriber-upload feature in
 * app/actions/subscribers.ts.
 */
export async function sendNewsletterNow(channelOutputId: string): Promise<SendResult> {
  const db = supabaseService();

  const { data: claimed, error: claimError } = await db
    .from("channel_outputs")
    .update({ publish_status: "sending", updated_at: new Date().toISOString() })
    .eq("id", channelOutputId)
    .in("publish_status", ["queued", "scheduled"])
    .select()
    .single();

  if (claimError) {
    // A real database error (not just "no row matched the compare-and-swap")
    // used to be indistinguishable from an already-claimed row here — both
    // returned the same silent skip, hiding an actual failure.
    return { status: "failed", error: claimError.message };
  }
  if (!claimed) {
    return { status: "skipped_already_claimed" };
  }

  try {
    const campaign = await brevo().emailCampaigns.createEmailCampaign({
      name: `${claimed.subject ?? "Newsletter"} — ${channelOutputId}`,
      subject: claimed.subject ?? "Newsletter",
      htmlContent: renderNewsletterHtml(claimed.subject ?? "", claimed.body),
      sender: brevoSender(),
      recipients: { listIds: [brevoListId()] },
    });

    await brevo().emailCampaigns.sendEmailCampaignNow({ campaignId: campaign.id });

    try {
      await assertOk(
        db
          .from("channel_outputs")
          .update({
            publish_status: "sent",
            sent_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", channelOutputId),
        "channel_outputs sent update"
      );
    } catch (writeErr) {
      // The email genuinely sent via Brevo at this point — reporting
      // "failed" here would be a lie that could prompt a real double-send
      // on retry. Log it and still report success; the row is left at
      // "sending" rather than "sent," which is a stale-status annoyance,
      // not a silent failure of the thing that actually matters.
      console.error(`channel_outputs sent update failed for ${channelOutputId} after a real send:`, writeErr);
    }

    await notifyNewsletterSent(channelOutputId);

    return { status: "sent" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await assertOk(
        db
          .from("channel_outputs")
          .update({ publish_status: "failed", last_error: message, updated_at: new Date().toISOString() })
          .eq("id", channelOutputId),
        "channel_outputs failed-send update"
      );
    } catch (writeErr) {
      console.error(`channel_outputs failed-send update also failed for ${channelOutputId}:`, writeErr);
    }
    return { status: "failed", error: message };
  }
}

export async function scheduleNewsletter(channelOutputId: string, scheduledFor: string): Promise<void> {
  const db = supabaseService();
  await assertOk(
    db
      .from("channel_outputs")
      .update({ publish_status: "scheduled", scheduled_for: scheduledFor, updated_at: new Date().toISOString() })
      .eq("id", channelOutputId)
      .eq("review_status", "approved"),
    "channel_outputs schedule update"
  );
}

/** Sweeps due scheduled sends. Called by the optional cron target (POST /api/publish/run-due). */
export async function runDueScheduledSends(): Promise<{ processed: number }> {
  const db = supabaseService();
  const { data: due } = await db
    .from("channel_outputs")
    .select("id")
    .eq("publish_status", "scheduled")
    .lte("scheduled_for", new Date().toISOString());

  for (const row of due ?? []) {
    await sendNewsletterNow(row.id);
  }

  return { processed: due?.length ?? 0 };
}

function renderNewsletterHtml(subject: string, body: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
  return `<h1>${subject}</h1>\n${paragraphs}`;
}
