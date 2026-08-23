"use client";

import { useEffect, useState } from "react";

type Theme = "auto" | "light" | "dark";
const ORDER: Theme[] = ["auto", "light", "dark"];

function apply(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  if (theme !== "auto") root.classList.add(theme);
  try {
    if (theme === "auto") localStorage.removeItem("wd_theme");
    else localStorage.setItem("wd_theme", theme);
  } catch {
    // storage may be blocked; the toggle still works for this page view
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("auto");

  useEffect(() => {
    try {
      const stored = localStorage.getItem("wd_theme");
      if (stored === "light" || stored === "dark") setTheme(stored);
    } catch {
      // ignore
    }
  }, []);

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    setTheme(next);
    apply(next);
  };

  return (
    <button
      type="button"
      onClick={cycle}
      className="cursor-pointer hover:text-foreground"
      title="cycle theme"
    >
      theme {theme}
    </button>
  );
}
