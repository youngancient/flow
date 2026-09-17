/** Small hand-coded generic-person glyph — no icon library added for one simple shape, same call as ThemeToggle's sun/moon/monitor icons. Used inside the colored circle placeholder in LinkedInPreview/XPreview. */
export function AvatarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="white" className={className} aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M12 13c-4.97 0-9 3.582-9 8v1h18v-1c0-4.418-4.03-8-9-8z" />
    </svg>
  );
}
