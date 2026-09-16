import { NextResponse, type NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/supabase/auth";
import { supabaseService } from "@/lib/supabase/service";
import { assertOk } from "@/lib/supabase/assert";
import { sendNewsletterNow } from "@/lib/publish";

export async function POST(request: NextRequest, { params }: { params: Promise<{ channelOutputId: string }> }) {
  const actingEmail = await requireApiAuth(request);
  if (!actingEmail) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { channelOutputId } = await params;
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("review_status, reviewed_by")
    .eq("id", channelOutputId)
    .single();

  if (!output) {
    return NextResponse.json({ ok: false, error: "Channel output not found" }, { status: 404 });
  }
  if (output.review_status !== "approved") {
    return NextResponse.json({ ok: false, error: "Cannot send before approval" }, { status: 403 });
  }
  if (!output.reviewed_by) {
    try {
      await assertOk(db.from("channel_outputs").update({ reviewed_by: actingEmail }).eq("id", channelOutputId), "channel_outputs reviewed_by backfill");
    } catch (err) {
      // Attribution-only field — don't block a real send over it, just don't pretend it worked silently.
      console.error(`channel_outputs reviewed_by backfill failed for ${channelOutputId}:`, err);
    }
  }

  const result = await sendNewsletterNow(channelOutputId);

  if (result.status === "failed") {
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true, status: result.status });
}
