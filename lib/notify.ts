import "server-only";
import { brevo, brevoSender } from "./brevo";
import { supabaseService } from "./supabase/service";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

/**
 * Best-effort action-confirmation emails (artifact/design.md,
 * "Notifications"). A notification failure is logged but never rolls back
 * or fails the action it's attached to.
 */

export async function notifyReadyForReview(requestId: string): Promise<void> {
  try {
    const db = supabaseService();
    const { data: request } = await db
      .from("content_requests")
      .select("requested_by, raw_idea")
      .eq("id", requestId)
      .single();
    if (!request) return;

    await brevo().transactionalEmails.sendTransacEmail({
      sender: brevoSender(),
      to: [{ email: request.requested_by }],
      subject: `Ready to review: ${request.raw_idea.slice(0, 60)}`,
      htmlContent: `<p>Your content request is ready to review.</p><p><a href="${APP_URL}/requests/${requestId}">${APP_URL}/requests/${requestId}</a></p>`,
    });
  } catch (err) {
    console.error("notifyReadyForReview failed:", err);
  }
}

export async function notifyNewsletterSent(channelOutputId: string): Promise<void> {
  try {
    const db = supabaseService();
    const { data: output } = await db
      .from("channel_outputs")
      .select("reviewed_by, subject, request_id")
      .eq("id", channelOutputId)
      .single();
    if (!output?.reviewed_by) return;

    await brevo().transactionalEmails.sendTransacEmail({
      sender: brevoSender(),
      to: [{ email: output.reviewed_by }],
      subject: `Sent: ${output.subject ?? "Newsletter"}`,
      htmlContent: `<p>The newsletter "${output.subject ?? ""}" was sent.</p><p><a href="${APP_URL}/requests/${output.request_id}">View request</a></p>`,
    });
  } catch (err) {
    console.error("notifyNewsletterSent failed:", err);
  }
}
