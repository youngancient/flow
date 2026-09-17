"use client";

import { useState } from "react";
import { toast } from "sonner";
import { retryPipelineRun } from "@/app/requests/[id]/actions";
import { Spinner } from "./Spinner";

export function RetryButton({ requestId }: { requestId: string }) {
  const [pending, setPending] = useState(false);

  async function handleRetry() {
    setPending(true);
    const res = await retryPipelineRun(requestId);
    setPending(false);
    if (!res.ok) toast.error(res.error);
    else toast.success("Retried");
  }

  return (
    <button
      onClick={handleRetry}
      disabled={pending}
      className="inline-flex cursor-pointer items-center gap-1.5 border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending && <Spinner />}
      {pending ? "Retrying…" : "Retry"}
    </button>
  );
}
