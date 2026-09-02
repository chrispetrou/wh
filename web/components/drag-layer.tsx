"use client";

// a row picked up from a log or prs block and carried across the
// transcript: a chip follows the pointer, the drop target under it
// ([data-drop]) lights up, the scroll box crawls when the pointer nears
// its edges, and the drop hands the payload and the target to the
// terminal. sources call startDrag from a pointermove past a threshold;
// the layer owns the rest through window listeners

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface DragPayload {
  kind: "commit" | "pr";
  id: string; // a sha, or a pr number
  label: string; // what the chip says
}

export interface Drop {
  target: string; // the data-drop value: "branch:<name>" or "plan:<line>"
  payload: DragPayload;
  row: number | null; // the [data-row] under the pointer inside the target, if any
}

interface Session {
  payload: DragPayload;
  x: number;
  y: number;
  over: string | null;
}

let current: Session | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

export function startDrag(payload: DragPayload, at: { clientX: number; clientY: number }) {
  current = { payload, x: at.clientX, y: at.clientY, over: null };
  document.body.classList.add("dragging");
  emit();
}

export const dragging = (): boolean => current !== null;

function end() {
  current = null;
  document.body.classList.remove("dragging");
  document.querySelectorAll(".drop-over").forEach((el) => el.classList.remove("drop-over"));
  emit();
}

const EDGE = 40;
const CRAWL = 6;

export function DragLayer({ onDrop }: { onDrop: (d: Drop) => void }) {
  const [, tick] = useState(0);
  const dropRef = useRef(onDrop);
  useEffect(() => {
    dropRef.current = onDrop;
  });

  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);

  useEffect(() => {
    const under = (x: number, y: number) => document.elementFromPoint(x, y);
    const clearOver = () =>
      document.querySelectorAll(".drop-over").forEach((el) => el.classList.remove("drop-over"));
    const move = (e: PointerEvent) => {
      if (!current) return;
      current.x = e.clientX;
      current.y = e.clientY;
      const t = under(e.clientX, e.clientY)?.closest<HTMLElement>("[data-drop]") ?? null;
      const id = t?.dataset.drop ?? null;
      if (id !== current.over) {
        clearOver();
        t?.classList.add("drop-over");
        current.over = id;
      }
      emit();
    };
    const up = () => {
      if (!current) return;
      const s = current;
      const el = s.over ? under(s.x, s.y) : null;
      end();
      if (!s.over || !el) return;
      const target = el.closest<HTMLElement>("[data-drop]");
      const rowEl = el.closest<HTMLElement>("[data-row]");
      const rows = target ? [...target.querySelectorAll<HTMLElement>("[data-row]")] : [];
      const row = rowEl ? rows.indexOf(rowEl) : -1;
      dropRef.current({ target: s.over, payload: s.payload, row: row >= 0 ? row : null });
    };
    // esc abandons the drag, dropping nothing
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && current) {
        e.preventDefault();
        e.stopPropagation();
        end();
      }
    };
    // the scroll box crawls while the pointer sits near its top or bottom
    let raf = 0;
    const crawl = () => {
      if (current) {
        const box = document.querySelector<HTMLElement>(".term-scroll");
        if (box) {
          const r = box.getBoundingClientRect();
          if (current.y < r.top + EDGE) box.scrollTop -= CRAWL;
          else if (current.y > r.bottom - EDGE) box.scrollTop += CRAWL;
        }
      }
      raf = requestAnimationFrame(crawl);
    };
    raf = requestAnimationFrame(crawl);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    // capture so it beats the terminal's own esc (stop, close menu)
    window.addEventListener("keydown", key, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
    };
  }, []);

  if (!current) return null;
  return createPortal(
    <div className="drag-ghost" style={{ left: current.x + 12, top: current.y + 12 }} aria-hidden="true">
      {current.payload.label}
    </div>,
    document.body
  );
}
