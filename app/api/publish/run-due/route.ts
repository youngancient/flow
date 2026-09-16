import { NextResponse, type NextRequest } from "next/server";
import { runDueScheduledSends } from "@/lib/publish";

/**
 * Optional cron target (Vercel Cron or similar) for due scheduled sends —
 * PRD explicitly accepts a clear publishing queue as sufficient on its own,
 * so this is a stretch, not a requirement. CRON_SECRET-protected, not
 * user-session-protected, since the caller has no session.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization");

  if (!secret || provided !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const result = await runDueScheduledSends();
  return NextResponse.json({ ok: true, ...result });
}
