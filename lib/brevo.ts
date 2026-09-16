import "server-only";
import { BrevoClient } from "@getbrevo/brevo";

let client: BrevoClient | null = null;

/**
 * Shared Brevo client — replaces Resend for all email sending (both the
 * bulk newsletter campaign and the single-recipient notification emails).
 * Switched from Resend because Resend's only path without a verified
 * domain (`onboarding@resend.dev`) can only deliver to the account owner's
 * own email; Brevo's single-sender verification (no domain required) can
 * deliver to any real recipient. See artifact/design.md, "Notifications".
 */
export function brevo(): BrevoClient {
  if (client) return client;
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error("Missing BREVO_API_KEY env var");
  client = new BrevoClient({ apiKey });
  return client;
}

export function brevoSender(): { email: string; name: string } {
  const email = process.env.BREVO_SENDER_EMAIL;
  const name = process.env.BREVO_SENDER_NAME ?? "Flow";
  if (!email) throw new Error("Missing BREVO_SENDER_EMAIL env var — must be a verified sender in Brevo");
  return { email, name };
}

export function brevoListId(): number {
  const raw = process.env.BREVO_LIST_ID;
  if (!raw) throw new Error("Missing BREVO_LIST_ID env var — create a list in the Brevo dashboard first");
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new Error(`BREVO_LIST_ID is not a valid integer: ${raw}`);
  return id;
}

export type SubscriberPreviewRow = {
  email: string;
  createdAt: string;
  unsubscribed: boolean;
};

export type SubscriberPreview = {
  rows: SubscriberPreviewRow[];
  totalCount: number;
};

const SUBSCRIBER_PREVIEW_LIMIT = 50;

/**
 * Read-only preview of the real Brevo list for /queue — never a management
 * UI (no add/remove/edit). Displaying vendor data is fine; rebuilding
 * vendor write-capability is the redundancy already removed once (see
 * artifact/design.md, "Newsletter subscribers").
 */
export async function getSubscriberPreview(): Promise<SubscriberPreview> {
  const { contacts, count } = await brevo().contacts.getContactsFromList({
    listId: brevoListId(),
    limit: SUBSCRIBER_PREVIEW_LIMIT,
    sort: "desc",
  });

  return {
    rows: contacts
      .filter((c): c is typeof c & { email: string } => Boolean(c.email))
      .map((c) => ({ email: c.email, createdAt: c.createdAt, unsubscribed: c.emailBlacklisted })),
    totalCount: count,
  };
}
