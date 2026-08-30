"use client";

// the small pieces every block renderer shares: an inline action, a copy
// action that confirms in place, a ref chip, and the absolute timestamp
// behind a relative age

import { useState } from "react";

export function absolute(iso: string): string {
  return new Date(iso)
    .toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
    .toLowerCase();
}

export function Chip({ name, color }: { name: string; color: string }) {
  return (
    <span className="chip" style={{ color }}>
      {name}
    </span>
  );
}

export function Action({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="log-action" onClick={onClick}>
      {children}
    </button>
  );
}

// copy with a moment of confirmation in place of the label
export function CopyAction({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Action
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "copied" : "copy"}
    </Action>
  );
}
