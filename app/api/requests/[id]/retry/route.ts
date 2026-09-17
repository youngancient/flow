import { NextResponse, type NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/supabase/auth";
import { supabaseService } from "@/lib/supabase/service";
import { runPipeline } from "@/lib/pipeline";

export const maxDuration = 300;

/** Idempotent re-invoke after a failure — resumes from the failed stage, per lib/pipeline.ts's existence checks. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actingEmail = await requireApiAuth(request);
  if (!actingEmail) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const db = supabaseService();

  const { data: existing } = await db.from("content_requests").select("requested_by").eq("id", id).single();
  if (!existing) {
    return NextResponse.json({ ok: false, error: "Request not found" }, { status: 404 });
  }
  if (existing.requested_by !== actingEmail) {
    return NextResponse.json({ ok: false, error: "Only this request's owner can do that" }, { status: 403 });
  }

  await runPipeline(id);

  const { data: final } = await db.from("content_requests").select("*").eq("id", id).single();
  return NextResponse.json({ ok: final?.stage !== "failed", data: final });
}
