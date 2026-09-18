import "server-only";

/**
 * Core env vars the app cannot function without. Deliberately excludes
 * vars that are optional by design and already handled gracefully
 * elsewhere: DISCORD_BOT_TOKEN/DISCORD_CHANNEL_ID/DISCORD_API_BASE_URL
 * (postPipelineError no-ops if any is unset), CRON_SECRET (the optional
 * run-due route just 401s without it), TESTING_API_TOKEN (falls back to
 * requiring a real session), and BREVO_SENDER_NAME (has a sane code
 * default). Making those hard-required here would contradict their own
 * documented "best-effort, never blocks" design (artifact/design.md,
 * "Notifications"). APP_URL and VOYAGE_EMBEDDINGS_URL used to have code
 * defaults too but no longer do — they're listed below instead.
 */
const REQUIRED_ENV_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "FIRECRAWL_API_KEY",
  "VOYAGE_API_KEY",
  "VOYAGE_EMBEDDINGS_URL",
  "BREVO_API_KEY",
  "BREVO_SENDER_EMAIL",
  "BREVO_LIST_ID",
  "APP_URL",
] as const;

/**
 * Fails fast and loud with one clear, complete list of what's missing,
 * instead of each lib module discovering it lazily one at a time the
 * first time something happens to call it. Called once from
 * instrumentation.ts's register(), which Next.js runs before the server
 * starts accepting requests — not during `next build` (skipped via
 * PHASE_PRODUCTION_BUILD, since build environments often don't have
 * runtime secrets provisioned).
 */
export function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `See .env.example for what each one is and where to get it.`
    );
  }
}
