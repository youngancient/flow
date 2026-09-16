"use client";

import { useEffect } from "react";

/** Small reusable popup shell — Escape and backdrop click both close it. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 overflow-y-auto border border-rule bg-paper p-5 shadow-lg"
      >
        <div className="flex items-center justify-between border-b border-rule pb-2">
          <span className="font-sans text-xs font-semibold text-muted">{title}</span>
          <button onClick={onClose} className="cursor-pointer text-muted hover:text-ink" aria-label="Close preview">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
