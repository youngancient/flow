import { NextResponse, type NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/supabase/auth";
import { supabaseService } from "@/lib/supabase/service";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actingEmail = await requireApiAuth(request);
  if (!actingEmail) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const db = supabaseService();

  const [content_request, sources, drafts, evaluations, channel_outputs] = await Promise.all([
    db.from("content_requests").select("*").eq("id", id).single(),
    db.from("sources").select("*").eq("request_id", id),
    db.from("drafts").select("*").eq("request_id", id).order("option_label").order("version"),
    db
      .from("evaluations")
      .select("*, drafts!inner(request_id)")
      .eq("drafts.request_id", id),
    db.from("channel_outputs").select("*").eq("request_id", id),
  ]);

  if (content_request.error || !content_request.data) {
    return NextResponse.json({ ok: false, error: "Request not found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    data: {
      request: content_request.data,
      sources: sources.data ?? [],
      drafts: drafts.data ?? [],
      evaluations: evaluations.data ?? [],
      channelOutputs: channel_outputs.data ?? [],
    },
  });
}
