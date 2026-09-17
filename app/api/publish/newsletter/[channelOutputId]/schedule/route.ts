import { NextResponse, type NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/supabase/auth";
import { supabaseService } from "@/lib/supabase/service";
import { scheduleNewsletter } from "@/lib/publish";

export async function POST(request: NextRequest, { params }: { params: Promise<{ channelOutputId: string }> }) {
  const actingEmail = await requireApiAuth(request);
  if (!actingEmail) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { channelOutputId } = await params;
  const body = await request.json().catch(() => null);
  if (!body?.scheduledFor) {
    return NextResponse.json({ ok: false, error: "scheduledFor is required" }, { status: 400 });
  }

  const db = supabaseService();
  const { data: output } = await db
    .from("channel_outputs")
    .select("review_status, publish_status, content_requests(requested_by)")
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
  if (output.review_status !== "approved") {
    return NextResponse.json({ ok: false, error: "Cannot schedule before approval" }, { status: 403 });
  }
  if (output.publish_status === "sent" || output.publish_status === "sending") {
    return NextResponse.json({ ok: false, error: "This has already been sent and can't be scheduled again" }, { status: 409 });
  }

  try {
    await scheduleNewsletter(channelOutputId, body.scheduledFor);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Failed to schedule" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
