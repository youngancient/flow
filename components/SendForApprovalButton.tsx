"use client";

import { useState } from "react";
import { toast } from "sonner";
import { sendForApproval } from "@/app/requests/[id]/actions";
import { Spinner } from "./Spinner";

export function SendForApprovalButton({ requestId }: { requestId: string }) {
  const [pending, setPending] = useState(false);

  async function handleSend() {
    setPending(true);
    const res = await sendForApproval(requestId);
    setPending(false);
    if (!res.ok) toast.error(res.error);
    else toast.success("Sent for approval");
  }

  return (
    <button
      onClick={handleSend}
      disabled={pending}
      className="inline-flex cursor-pointer items-center gap-1.5 border border-ink px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending && <Spinner />}
      {pending ? "Sending…" : "Send for approval"}
    </button>
  );
}
