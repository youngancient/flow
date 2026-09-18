"use client";

import { useEffect, useState } from "react";
import { formatDate, formatDateTime } from "@/lib/format";

/**
 * formatDate/formatDateTime resolve to the runtime's own local time zone.
 * From a Server Component that's Vercel's server time zone (UTC), not the
 * viewer's browser, so a request created at 4:12 AM in a UTC+1 time zone
 * was rendering as 3:12 AM everywhere this ran server-side. Rendering from
 * a client component instead means the browser's actual local time zone is
 * what formats it. Starts empty on both the server and client's first
 * render, nothing for hydration to diff, then fills in client-only after
 * mount, the same pattern RequestForm's submissionKey and PipelineProgress's
 * elapsed timer already use for this exact reason.
 */
export function LocalTime({ iso, withTime = false }: { iso: string; withTime?: boolean }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(withTime ? formatDateTime(iso) : formatDate(iso));
  }, [iso, withTime]);

  return <>{text}</>;
}
