// the previews force a theme from ?theme= instead of reading storage, so a
// screenshot never depends on the machine taking it. every class below
// suppresses the prefers-color-scheme block in globals.css, so exactly one
// of them is on at a time and the system palette can't leak in.
import { isTheme, THEMES, type Theme } from "@/lib/terminal/prefs";

const CLASSES = THEMES.filter((t) => t !== "auto");

export function previewTheme(value: string | undefined): Theme {
  return value && isTheme(value) && value !== "auto" ? value : "light";
}

export function applyPreviewTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove(...CLASSES);
  root.classList.add(theme === "auto" ? "light" : theme);
}
