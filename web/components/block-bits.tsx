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

// a value still in flight
export function Skel({ w }: { w: number }) {
  return <span className="skel" style={{ width: `${w}ch` }} />;
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

// a short sha that copies the full one; the label swap is padded to the
// cell's 7ch so the column never shifts. click must not bubble: the row
// around it expands on click
export function CopySha({ sha }: { sha: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      data-tip="copy sha"
      aria-label={`copy sha ${sha.slice(0, 7)}`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(sha);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="log-cell log-sha text-muted-foreground hover:text-foreground"
    >
      {done ? "copied " : sha.slice(0, 7)}
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
