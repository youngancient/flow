import { PHASE_PRODUCTION_BUILD } from "next/constants";

/**
 * Runs once when a new Next.js server instance starts, before it accepts
 * any requests (dev server boot, `next start`, or a serverless cold
 * start) — the officially sanctioned place for a boot-time config check,
 * not a workaround. Skipped during `next build` itself, since build
 * environments often don't have runtime secrets provisioned and this
 * phase never actually serves a request.
 */
export async function register() {
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return;

  const { assertRequiredEnv } = await import("./lib/env");
  assertRequiredEnv();
}
