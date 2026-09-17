import { NextResponse, type NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/supabase/auth";
import { supabaseService } from "@/lib/supabase/service";
import { assertOk } from "@/lib/supabase/assert";

/** Reverts a scheduled newsletter back to approved/queued, clearing scheduled_for — the counterpart to .../schedule. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ channelOutputId: string }> }) {
  const actingEmail = await requireApiAuth(request);
  if (!actingEmail) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { channelOutputId } = await params;
  const db = supabaseService();

  const { data: output } = await db
    .from("channel_outputs")
    .select("publish_status, content_requests(requested_by)")
    .eq("id", channelOutputId)
    .single();
  if (!output) {
    return NextResponse.json({ ok: false, error: "Channel output not found" }, { status: 404 });
  }
  const ownerField = output.content_requests as { requested_by: string } | { requested_by: string }[] | null;
  const owner = Array.isArray(ownerField) ? ownerField[0]?.requested_by : ownerField?.requested_by;
  if (owner !== actingEmail) {
    return NextResponse.json({ ok: false, error: "Only this request's owner can do that" }, { status: 403 });
  }
  if (output.publish_status !== "scheduled") {
    return NextResponse.json({ ok: false, error: "This isn't currently scheduled" }, { status: 409 });
  }

  try {
    await assertOk(
      db
        .from("channel_outputs")
        .update({ publish_status: "queued", scheduled_for: null, updated_at: new Date().toISOString() })
        .eq("id", channelOutputId),
      "channel_outputs cancel-schedule update"
    );
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Failed to cancel schedule" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
