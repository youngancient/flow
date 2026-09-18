import "server-only";
import { brevo, brevoSender, brevoListId } from "./brevo";
import { supabaseService } from "./supabase/service";
import { assertOk } from "./supabase/assert";
import { notifyNewsletterSent } from "./notify";
import { postPipelineError } from "./discord";

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

  // Checked up front, before any mutation — the compare-and-swap claim below
  // would otherwise flip a wrong-channel row to "sending" before we ever
  // noticed, which would then need its own undo logic. A row reaching this
  // function at all with the wrong channel means something upstream (a
  // sweep query, a route handler, a future caller) failed to scope itself
  // to newsletter — that's a bug worth alerting on, not a silent skip.
  const { data: existing, error: fetchError } = await db
    .from("channel_outputs")
    .select("channel, request_id")
    .eq("id", channelOutputId)
    .single();

  if (fetchError || !existing) {
    return { status: "failed", error: fetchError?.message ?? "Channel output not found" };
  }
  if (existing.channel !== "newsletter") {
    const message = `channel_outputs ${channelOutputId} is a "${existing.channel}" row, not newsletter — refusing to send it as an email campaign`;
    console.error(message);
    postPipelineError({ requestId: existing.request_id, stage: "newsletter_channel_mismatch", error: message });
    return { status: "failed", error: message };
  }

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
    console.error(`channel_outputs claim update failed for ${channelOutputId}:`, claimError.message);
    postPipelineError({ requestId: existing.request_id, stage: "newsletter_claim", error: claimError.message });
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
    // A manual "Send now" failure at least shows a toast to whoever clicked
    // it — but this same path is also what the unattended cron sweep
    // (run-due) hits, where there's no one present to see anything. Fires
    // the same Discord alert pipeline failures use, so a 3am Brevo outage
    // doesn't sit invisible in last_error until someone happens to open
    // /queue.
    postPipelineError({ requestId: claimed.request_id, stage: "newsletter_send", error: message });
    return { status: "failed", error: message };
  }
}

export async function scheduleNewsletter(channelOutputId: string, scheduledFor: string): Promise<void> {
  const db = supabaseService();

  // A bare .eq("channel", "newsletter") added to the update's WHERE filters
  // below would just silently match zero rows for the wrong channel —
  // assertOk only catches a real Postgres error, not "nothing matched" — so
  // this has to be an explicit check that throws, same reasoning as
  // sendNewsletterNow's channel guard.
  const { data: existing } = await db.from("channel_outputs").select("channel").eq("id", channelOutputId).single();
  if (existing?.channel !== "newsletter") {
    throw new Error(`channel_outputs ${channelOutputId} is a "${existing?.channel ?? "unknown"}" row, not newsletter`);
  }

  await assertOk(
    db
      .from("channel_outputs")
      .update({ publish_status: "scheduled", scheduled_for: scheduledFor, updated_at: new Date().toISOString() })
      .eq("id", channelOutputId)
      .eq("review_status", "approved")
      // Defense-in-depth backstop, not the only guard (the route handler
      // above already checks this with a clear error) — a sent/sending row
      // can never be re-scheduled no matter which caller reaches this.
      .in("publish_status", ["not_queued", "queued", "scheduled", "failed"]),
    "channel_outputs schedule update"
  );
}

/** Sweeps due scheduled sends. Called by the optional cron target (POST /api/publish/run-due). */
export async function runDueScheduledSends(): Promise<{ processed: number; sent: number; failed: number }> {
  const db = supabaseService();
  const { data: due } = await db
    .from("channel_outputs")
    .select("id")
    .eq("channel", "newsletter")
    .eq("publish_status", "scheduled")
    .lte("scheduled_for", new Date().toISOString());

  let sent = 0;
  let failed = 0;
  for (const row of due ?? []) {
    // sendNewsletterNow already alerts Discord per-item on failure — this
    // loop's own job is just to make sure the sweep's own caller/logs don't
    // discard that outcome the way this used to (await with no result check).
    const result = await sendNewsletterNow(row.id);
    if (result.status === "sent") {
      sent++;
    } else if (result.status === "failed") {
      failed++;
      console.error(`runDueScheduledSends: send failed for channel_output ${row.id}:`, result.error);
    }
  }

  return { processed: due?.length ?? 0, sent, failed };
}

function renderNewsletterHtml(subject: string, body: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
  return `<h1>${subject}</h1>\n${paragraphs}`;
}
