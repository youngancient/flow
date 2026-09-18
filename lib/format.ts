/**
 * Shared date display formatting — no "server-only" here, since this is
 * used from client components (e.g. ChannelOutputCard) as well as server
 * ones. Renders "Sep 19th, 2026" instead of the locale-numeric "9/19/2026",
 * in the viewer's local time zone (same basis as the toLocaleString() calls
 * this replaces).
 */

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/** e.g. "Sep 19th, 2026" */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate();
  return `${MONTH_ABBR[d.getMonth()]} ${day}${ordinalSuffix(day)}, ${d.getFullYear()}`;
}

/** e.g. "Sep 19th, 2026, 3:00 PM" */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${formatDate(iso)}, ${time}`;
}

/** e.g. "45s", "1m02s" — for a live elapsed-time counter. */
export function formatElapsedSeconds(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}
