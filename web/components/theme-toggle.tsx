"use client";

import { useSyncExternalStore } from "react";
import { isTheme, THEMES, type Theme } from "@/lib/terminal/prefs";

export type { Theme };

// the header cycles the three everyday states only. vintage and amber are
// opt-in through /theme, so they never sit between a click and auto
const ORDER: Theme[] = ["auto", "light", "dark"];

// every theme class the root may be wearing, so a switch clears the others
const CLASSES = THEMES.filter((t) => t !== "auto");

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove(...CLASSES);
  if (theme !== "auto") root.classList.add(theme);
  try {
    if (theme === "auto") localStorage.removeItem("wh_theme");
    else localStorage.setItem("wh_theme", theme);
  } catch {
    // storage may be blocked; the toggle still works for this page view
  }
  window.dispatchEvent(new CustomEvent("wh-theme", { detail: theme }));
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
    // auto is the absent key, never a stored value
    const stored = localStorage.getItem("wh_theme") ?? "";
    if (stored !== "auto" && isTheme(stored)) return stored;
  } catch {
    // ignore
  }
  return "auto";
}

// applyTheme writes storage before dispatching, so currentTheme is the
// snapshot and the event is only the change signal
const subscribeTheme = (cb: () => void) => {
  window.addEventListener("wh-theme", cb);
  return () => window.removeEventListener("wh-theme", cb);
};

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => "auto" as Theme);

  // indexOf is -1 on vintage and amber, so the next step is auto: a click
  // from a phosphor theme drops back into the everyday cycle. intentional
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
