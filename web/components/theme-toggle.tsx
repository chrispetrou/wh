"use client";

import { useSyncExternalStore } from "react";

export type Theme = "auto" | "light" | "dark";
const ORDER: Theme[] = ["auto", "light", "dark"];

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  if (theme !== "auto") root.classList.add(theme);
  try {
    if (theme === "auto") localStorage.removeItem("wd_theme");
    else localStorage.setItem("wd_theme", theme);
  } catch {
    // storage may be blocked; the toggle still works for this page view
  }
  window.dispatchEvent(new CustomEvent("wd-theme", { detail: theme }));
}

// cross-fade the whole page where the browser can (see globals.css);
// a plain flip elsewhere and under reduced motion. the header toggle
// and /theme both go through here
export function switchTheme(next: Theme) {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => unknown;
  };
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (doc.startViewTransition && !still) doc.startViewTransition(() => applyTheme(next));
  else applyTheme(next);
}

export function currentTheme(): Theme {
  try {
    const stored = localStorage.getItem("wd_theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // ignore
  }
  return "auto";
}

// applyTheme writes storage before dispatching, so currentTheme is the
// snapshot and the event is only the change signal
const subscribeTheme = (cb: () => void) => {
  window.addEventListener("wd-theme", cb);
  return () => window.removeEventListener("wd-theme", cb);
};

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => "auto" as Theme);

  const cycle = () => switchTheme(ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]);

  return (
    <button
      type="button"
      onClick={cycle}
      className="cursor-pointer hover:text-foreground"
      data-tip="cycle theme: auto, light, dark (also /theme)"
    >
      theme {theme}
    </button>
  );
}
