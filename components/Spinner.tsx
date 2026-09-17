/** Small hand-coded spinner — no icon library for one shape, same approach as AvatarIcon/VerifiedBadge/ThemeToggle. Inherits the button's text color via currentColor. */
export function Spinner({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
