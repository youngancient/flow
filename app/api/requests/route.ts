import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { requireApiAuth } from "@/lib/supabase/auth";
import { supabaseService } from "@/lib/supabase/service";
import { contentRequestInputSchema } from "@/lib/schemas";
import { runPipeline } from "@/lib/pipeline";

export const maxDuration = 300;

/**
 * Curl-testable entry point (artifact/design.md, "API routes / Server
 * Actions") — validates, inserts, runs the pipeline synchronously, and
 * returns the final state. Used to produce the testing-evidence table.
 */
export async function POST(request: NextRequest) {
  const actingEmail = await requireApiAuth(request);
  if (!actingEmail) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = contentRequestInputSchema.safeParse({
    submissionKey: body.submissionKey ?? randomUUID(),
    rawIdea: body.rawIdea,
    targetAudience: body.targetAudience,
    sourceUrl: body.sourceUrl ?? "",
    supportingNotes: body.supportingNotes ?? "",
  });

  if (!parsed.success) {
    return NextResponse.json({ ok: false, stage: "validation", error: parsed.error.issues[0]?.message }, { status: 400 });
  }

  const db = supabaseService();

  const { data: existing } = await db
    .from("content_requests")
    .select("id")
    .eq("submission_key", parsed.data.submissionKey)
    .maybeSingle();

  let requestId: string;
  if (existing) {
    requestId = existing.id;
  } else {
    const { data: inserted, error } = await db
      .from("content_requests")
      .insert({
        requested_by: actingEmail,
        submission_key: parsed.data.submissionKey,
        raw_idea: parsed.data.rawIdea,
        target_audience: parsed.data.targetAudience,
        source_url: parsed.data.sourceUrl || null,
        supporting_notes: parsed.data.supportingNotes || null,
      })
      .select("id")
      .single();

    if (error || !inserted) {
      return NextResponse.json({ ok: false, stage: "insert", error: error?.message }, { status: 500 });
    }
    requestId = inserted.id;
  }

  await runPipeline(requestId);

  const { data: final } = await db.from("content_requests").select("*").eq("id", requestId).single();
  return NextResponse.json({ ok: final?.stage !== "failed", data: final });
}

export async function GET(request: NextRequest) {
  const actingEmail = await requireApiAuth(request);
  if (!actingEmail) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = supabaseService();
  const { data, error } = await db.from("content_requests").select("*").order("created_at", { ascending: false });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data });
}
