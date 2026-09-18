"use client";

import { useState } from "react";

const TRUNCATE_LENGTH = 200;

export function SupportingNotes({ notes }: { notes: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = notes.length > TRUNCATE_LENGTH;

  return (
    <p className="text-sm text-muted">
      {expanded || !needsTruncation ? notes : `${notes.slice(0, TRUNCATE_LENGTH).trimEnd()}…`}
      {needsTruncation && (
        <button type="button" onClick={() => setExpanded(!expanded)} className="ml-1 cursor-pointer underline">
          {expanded ? "See less" : "See more"}
        </button>
      )}
    </p>
  );
}
