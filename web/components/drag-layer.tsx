"use client";

// a row picked up from a log or prs block and carried across the
// transcript: a chip follows the pointer, the drop target under it
// ([data-drop]) lights up, the scroll box crawls when the pointer nears
// its edges, and the drop hands the payload and the target to the
// terminal. sources call startDrag from a pointermove past a threshold;
// the layer owns the rest through window listeners

import { useEffect, useRef, useSyncExternalStore } from "react";
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

// the session is a tiny external store: the component reads it through
// useSyncExternalStore and never touches the global itself. inside a
// compiled component the react compiler treats a module-level let as
// constant (it folds local aliases back into it and caches jsx that
// reads it), so every read and write lives here at module scope
let current: Session | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};
const snapshot = (): Session | null => current;
const none = (): Session | null => null;

export function startDrag(
  payload: DragPayload,
  at: { clientX: number; clientY: number },
) {
  current = { payload, x: at.clientX, y: at.clientY, over: null };
  document.body.classList.add("dragging");
  emit();
}

export const dragging = (): boolean => current !== null;

// a fresh object per move so the store snapshot changes identity
function moveTo(x: number, y: number, over: string | null) {
  if (!current) return;
  current = { ...current, x, y, over };
  emit();
}

function end() {
  current = null;
  document.body.classList.remove("dragging");
  document
    .querySelectorAll(".drop-over")
    .forEach((el) => el.classList.remove("drop-over"));
  emit();
}

// ends the drag and hands back the session it ended
function release(): Session | null {
  const s = current;
  if (s) end();
  return s;
}

const EDGE = 40;
const CRAWL = 6;

export function DragLayer({ onDrop }: { onDrop: (d: Drop) => void }) {
  const session = useSyncExternalStore(subscribe, snapshot, none);
  const dropRef = useRef(onDrop);
  useEffect(() => {
    dropRef.current = onDrop;
  });

  useEffect(() => {
    const under = (x: number, y: number) => document.elementFromPoint(x, y);
    const clearOver = () =>
      document
        .querySelectorAll(".drop-over")
        .forEach((el) => el.classList.remove("drop-over"));
    const move = (e: PointerEvent) => {
      const s = snapshot();
      if (!s) return;
      const t =
        under(e.clientX, e.clientY)?.closest<HTMLElement>("[data-drop]") ??
        null;
      const id = t?.dataset.drop ?? null;
      if (id !== s.over) {
        clearOver();
        t?.classList.add("drop-over");
      }
      moveTo(e.clientX, e.clientY, id);
    };
    const up = () => {
      const s = release();
      if (!s) return;
      const el = s.over ? under(s.x, s.y) : null;
      if (!s.over || !el) return;
      const target = el.closest<HTMLElement>("[data-drop]");
      const rowEl = el.closest<HTMLElement>("[data-row]");
      const rows = target
        ? [...target.querySelectorAll<HTMLElement>("[data-row]")]
        : [];
      const row = rowEl ? rows.indexOf(rowEl) : -1;
      dropRef.current({
        target: s.over,
        payload: s.payload,
        row: row >= 0 ? row : null,
      });
    };
    // esc abandons the drag, dropping nothing
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragging()) {
        e.preventDefault();
        e.stopPropagation();
        end();
      }
    };
    // the scroll box crawls while the pointer sits near its top or bottom
    let raf = 0;
    const crawl = () => {
      const s = snapshot();
      if (s) {
        const box = document.querySelector<HTMLElement>(".term-scroll");
        if (box) {
          const r = box.getBoundingClientRect();
          if (s.y < r.top + EDGE) box.scrollTop -= CRAWL;
          else if (s.y > r.bottom - EDGE) box.scrollTop += CRAWL;
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

  if (!session) return null;
  return createPortal(
    <div
      className="drag-ghost"
      style={{ left: session.x + 12, top: session.y + 12 }}
      aria-hidden="true"
    >
      {session.payload.label}
    </div>,
    document.body,
  );
}
