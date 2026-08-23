"use client";

import { useEffect, useState } from "react";

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

export function currentTheme(): Theme {
  try {
    const stored = localStorage.getItem("wd_theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // ignore
  }
  return "auto";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("auto");

  useEffect(() => {
    setTheme(currentTheme());
    const onTheme = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener("wd-theme", onTheme);
    return () => window.removeEventListener("wd-theme", onTheme);
  }, []);

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    setTheme(next);
    applyTheme(next);
  };

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
