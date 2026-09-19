"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { requireSessionEmail, isManager } from "@/lib/supabase/auth";
import { supabaseService } from "@/lib/supabase/service";
import { contentRequestInputSchema } from "@/lib/schemas";
import { runPipeline } from "@/lib/pipeline";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function createContentRequest(formData: FormData): Promise<ActionResult> {
  const requestedBy = await requireSessionEmail();
  if (await isManager()) {
    return { ok: false, error: "Managers review content, they don't submit requests" };
  }

  const parsed = contentRequestInputSchema.safeParse({
    submissionKey: formData.get("submissionKey"),
    rawIdea: formData.get("rawIdea"),
    targetAudience: formData.get("targetAudience"),
    // Multiple inputs share name="sourceUrls" (see RequestForm) — blank
    // rows come through as empty strings, so they're filtered before
    // validation rather than tripping the .url() check on each one.
    sourceUrls: formData.getAll("sourceUrls").map(String).map((s) => s.trim()).filter(Boolean),
    supportingNotes: formData.get("supportingNotes") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const db = supabaseService();

  // Duplicate-submission guard: a retried POST with the same submissionKey
  // returns the already-created request instead of starting a second run.
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
        requested_by: requestedBy,
        submission_key: parsed.data.submissionKey,
        raw_idea: parsed.data.rawIdea,
        target_audience: parsed.data.targetAudience,
        source_urls: parsed.data.sourceUrls,
        supporting_notes: parsed.data.supportingNotes || null,
      })
      .select("id")
      .single();

    if (error || !inserted) {
      return { ok: false, error: error?.message ?? "Could not create request" };
    }
    requestId = inserted.id;
  }

  // Fire-and-forget: runs after this response is sent, so the redirect below
  // happens almost immediately instead of blocking on the full 1-3 minute
  // pipeline. The review page shows real live progress (PipelineProgress)
  // by polling while the row is non-terminal — see artifact/design.md,
  // "Pipeline execution model."
  if (!existing) {
    after(() => runPipeline(requestId));
  }

  redirect(`/requests/${requestId}`);
}
