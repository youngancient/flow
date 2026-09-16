"use client";

import { useActionState, useEffect, useState } from "react";
import { createContentRequest, type ActionResult } from "@/app/actions";

export function RequestForm() {
  // Generated client-only, after mount — not in the render-time state
  // initializer. crypto.randomUUID() produces a different value on every
  // call, so computing it during the render that also runs on the server
  // (SSR) bakes one UUID into the server HTML and a second, different one
  // into the client's hydration pass, which is exactly the "server
  // rendered HTML didn't match the client properties" hydration warning.
  // An effect runs client-only, after hydration completes, so there's
  // nothing for React to diff it against.
  const [submissionKey, setSubmissionKey] = useState("");
  useEffect(() => {
    // One-time, mount-only assignment of a client-only random value — not
    // the cascading-update pattern this lint rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSubmissionKey(crypto.randomUUID());
  }, []);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    async (_prev, formData) => createContentRequest(formData),
    null
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="submissionKey" value={submissionKey} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="rawIdea" className="text-sm text-muted">
          Content idea <span className="text-flag">*</span>
        </label>
        <textarea
          id="rawIdea"
          name="rawIdea"
          required
          maxLength={500}
          rows={3}
          className="border border-rule bg-transparent p-2 text-sm outline-none focus:border-ink"
          placeholder="e.g. Why most B2B onboarding emails get ignored"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="targetAudience" className="text-sm text-muted">
          Target audience <span className="text-flag">*</span>
        </label>
        <input
          id="targetAudience"
          name="targetAudience"
          required
          maxLength={300}
          className="border border-rule bg-transparent px-2 py-1.5 text-sm outline-none focus:border-ink"
          placeholder="e.g. Marketing directors at mid-market SaaS companies"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="sourceUrl" className="text-sm text-muted">
          Source URL (optional)
        </label>
        <input
          id="sourceUrl"
          name="sourceUrl"
          type="url"
          className="border border-rule bg-transparent px-2 py-1.5 text-sm outline-none focus:border-ink"
          placeholder="https://…"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="supportingNotes" className="text-sm text-muted">
          Supporting notes or voice sample (optional)
        </label>
        <textarea
          id="supportingNotes"
          name="supportingNotes"
          maxLength={5000}
          rows={3}
          className="border border-rule bg-transparent p-2 text-sm outline-none focus:border-ink"
          placeholder="Anything the writer should know: brand voice, stats to include, angle to avoid"
        />
      </div>

      {state && !state.ok && <p className="text-sm text-flag">{state.error}</p>}

      <button
        type="submit"
        disabled={isPending}
        className="mt-1 cursor-pointer self-start border border-ink bg-ink px-4 py-2 text-sm font-medium text-paper disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? "Submitting…" : "Submit request"}
      </button>
    </form>
  );
}
