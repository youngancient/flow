"use client";

import { useEffect, useState } from "react";

type ThemeChoice = "system" | "light" | "dark";

const ORDER: ThemeChoice[] = ["system", "light", "dark"];
const TITLE: Record<ThemeChoice, string> = {
  system: "Theme: matching system — click for light",
  light: "Theme: light — click for dark",
  dark: "Theme: dark — click for system",
};

function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    localStorage.setItem("theme", choice);
  } catch {
    // Private browsing / storage blocked — theme just won't persist across reloads.
  }
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="8" cy="8" r="3.2" />
      <path d="M8 0.75v1.7M8 13.55v1.7M15.25 8h-1.7M2.45 8H0.75M13.03 2.97l-1.2 1.2M4.17 11.83l-1.2 1.2M13.03 13.03l-1.2-1.2M4.17 4.17l-1.2-1.2" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.8 9.4A6 6 0 0 1 6.6 2.2a6.2 6.2 0 1 0 7.2 7.2Z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <rect x="1" y="2.5" width="14" height="8.5" rx="1" />
      <path d="M5.5 14h5M8 11v3" strokeLinecap="round" />
    </svg>
  );
}

const ICON: Record<ThemeChoice, () => React.JSX.Element> = { system: SystemIcon, light: SunIcon, dark: MoonIcon };

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>("system");

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("theme");
    } catch {
      // Same as above — fall back to "system" silently.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of a client-only persisted value, not a cascading update
    if (stored === "light" || stored === "dark") setTheme(stored);
  }, []);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    setTheme(next);
    applyTheme(next);
  }

  const Icon = ICON[theme];

  return (
    <button onClick={cycle} title={TITLE[theme]} aria-label={TITLE[theme]} className="cursor-pointer text-muted hover:text-ink">
      <Icon />
    </button>
  );
}
