import "server-only";
import { brevo, brevoSender } from "./brevo";
import { supabaseService } from "./supabase/service";

/**
 * Best-effort action-confirmation emails (artifact/design.md,
 * "Notifications"). A notification failure is logged but never rolls back
 * or fails the action it's attached to.
 */

/**
 * Every account with `raw_app_meta_data.role = 'manager'` (see
 * lib/supabase/auth.ts's requireManager). There's no manager table to query
 * — the Admin API is the only way to enumerate Supabase auth users, so this
 * pages through all of them rather than assuming they fit on one page.
 */
async function getManagerEmails(): Promise<string[]> {
  const db = supabaseService();
  const emails: string[] = [];
  let page = 1;
  const perPage = 200;
  while (true) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    for (const user of data.users) {
      if (user.app_metadata?.role === "manager" && user.email) emails.push(user.email);
    }
    if (data.users.length < perPage) break;
    page++;
  }
  return emails;
}

const CHANNEL_LABEL: Record<string, string> = { linkedin: "LinkedIn", x: "X", newsletter: "Newsletter" };

export async function notifyReadyForReview(requestId: string): Promise<void> {
  try {
    const appUrl = process.env.APP_URL;
    if (!appUrl) throw new Error("Missing APP_URL env var");
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
      htmlContent: `<p>Your content request is ready to review.</p><p><a href="${appUrl}/requests/${requestId}">${appUrl}/requests/${requestId}</a></p>`,
    });
  } catch (err) {
    console.error("notifyReadyForReview failed:", err);
  }
}

/** Fires when a request's channel outputs move from 'draft' to 'pending_review' — on the initial "Send for approval" and again on every resubmit after a reject/changes-requested. Goes to every manager, not the requester. */
export async function notifyManagerForReview(requestId: string): Promise<void> {
  try {
    const appUrl = process.env.APP_URL;
    if (!appUrl) throw new Error("Missing APP_URL env var");
    const db = supabaseService();
    const { data: request } = await db
      .from("content_requests")
      .select("requested_by, raw_idea")
      .eq("id", requestId)
      .single();
    if (!request) return;

    const managerEmails = await getManagerEmails();
    if (managerEmails.length === 0) return;

    await brevo().transactionalEmails.sendTransacEmail({
      sender: brevoSender(),
      to: managerEmails.map((email) => ({ email })),
      subject: `Needs your review: ${request.raw_idea.slice(0, 60)}`,
      htmlContent: `<p>${request.requested_by} submitted content for approval.</p><p><a href="${appUrl}/requests/${requestId}">${appUrl}/requests/${requestId}</a></p>`,
    });
  } catch (err) {
    console.error("notifyManagerForReview failed:", err);
  }
}

const DECISION_LABEL: Record<"approved" | "rejected" | "changes_requested" | "unapproved", string> = {
  approved: "approved",
  rejected: "rejected",
  changes_requested: "asked for changes on",
  unapproved: "un-approved",
};

/**
 * Fires on approve/reject/request-changes/unapprove — to the requester,
 * carrying the manager's comment when there is one. `decision` and
 * `actingEmail` are passed explicitly rather than read back off the row,
 * since by the time this runs the caller has already written the new
 * review_status (and, for unapprove, cleared reviewed_by) — reading state
 * that was just overwritten would mislabel the email or lose who acted.
 */
export async function notifyReviewDecision(
  channelOutputId: string,
  decision: "approved" | "rejected" | "changes_requested" | "unapproved",
  actingEmail: string
): Promise<void> {
  try {
    const appUrl = process.env.APP_URL;
    if (!appUrl) throw new Error("Missing APP_URL env var");
    const db = supabaseService();
    const { data: output } = await db
      .from("channel_outputs")
      .select("channel, review_comment, request_id, content_requests(requested_by, raw_idea)")
      .eq("id", channelOutputId)
      .single();
    if (!output) return;
    const request = Array.isArray(output.content_requests) ? output.content_requests[0] : output.content_requests;
    if (!request) return;

    const channelLabel = CHANNEL_LABEL[output.channel] ?? output.channel;
    const decisionLabel = DECISION_LABEL[decision];

    await brevo().transactionalEmails.sendTransacEmail({
      sender: brevoSender(),
      to: [{ email: request.requested_by }],
      subject: `${actingEmail} ${decisionLabel} ${channelLabel}: ${request.raw_idea.slice(0, 60)}`,
      htmlContent: `<p>${actingEmail} ${decisionLabel} the ${channelLabel} output.</p>${
        output.review_comment ? `<p>Note: ${output.review_comment}</p>` : ""
      }<p><a href="${appUrl}/requests/${output.request_id}">${appUrl}/requests/${output.request_id}</a></p>`,
    });
  } catch (err) {
    console.error("notifyReviewDecision failed:", err);
  }
}

export async function notifyNewsletterSent(channelOutputId: string): Promise<void> {
  try {
    const appUrl = process.env.APP_URL;
    if (!appUrl) throw new Error("Missing APP_URL env var");
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
      htmlContent: `<p>The newsletter "${output.subject ?? ""}" was sent.</p><p><a href="${appUrl}/requests/${output.request_id}">View request</a></p>`,
    });
  } catch (err) {
    console.error("notifyNewsletterSent failed:", err);
  }
}
