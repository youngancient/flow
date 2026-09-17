/** Hand-coded verified-account badge (scalloped seal + checkmark) — same "no icon library for a simple shape" approach as AvatarIcon/ThemeToggle. */
export function VerifiedBadge({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#1d9bf0"
        d="M12 2l2.4 1.4 2.6-.6 1.2 2.4 2.4 1.2-.6 2.6 1.4 2.4-1.4 2.4.6 2.6-2.4 1.2-1.2 2.4-2.6-.6L12 22l-2.4-1.4-2.6.6-1.2-2.4-2.4-1.2.6-2.6L2 12l1.4-2.4-.6-2.6 2.4-1.2 1.2-2.4 2.6.6L12 2z"
      />
      <path d="M9.3 12.5l1.9 1.9 3.8-4.2" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
