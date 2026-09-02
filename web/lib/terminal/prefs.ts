// per-browser preferences the terminal keeps in localStorage: font,
// size, ligatures, the one-time hints, the recent repos for the picker.
// storage and the document root are parameters so this runs in node.
import type { StorageLike } from "../key-store";

export function createPrefs(storage: StorageLike) {
  return {
    get(key: string): string {
      try {
        return storage.getItem(key) ?? "";
      } catch {
        return "";
      }
    },
    set(key: string, value: string) {
      try {
        if (value) storage.setItem(key, value);
        else storage.removeItem(key);
      } catch {
        // private windows may block storage; the value just won't persist
      }
    },
  };
}

export type Prefs = ReturnType<typeof createPrefs>;

// localStorage is absent during ssr and may throw in private windows
const browserStorage: StorageLike = {
  getItem: (k) => (typeof localStorage === "undefined" ? null : localStorage.getItem(k)),
  setItem: (k, v) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(k, v);
  },
  removeItem: (k) => {
    if (typeof localStorage !== "undefined") localStorage.removeItem(k);
  },
};

export const prefs = createPrefs(browserStorage);

// the part of document.documentElement the appliers touch
export interface RootLike {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
}

const root = (): RootLike => document.documentElement;

export function applyFont(font: string, r: RootLike = root(), p: Prefs = prefs) {
  if (font === "default") r.removeAttribute("data-font");
  else r.setAttribute("data-font", font);
  p.set("wh_font", font === "default" ? "" : font);
}

export function applyFontSize(size: string, r: RootLike = root(), p: Prefs = prefs) {
  if (size === "default") r.style.removeProperty("--wh-font-size");
  else r.style.setProperty("--wh-font-size", `${size}px`);
  p.set("wh_fontsize", size === "default" ? "" : size);
}

export function applyLigatures(on: boolean, r: RootLike = root(), p: Prefs = prefs) {
  if (on) r.removeAttribute("data-lig");
  else r.setAttribute("data-lig", "off");
  p.set("wh_lig", on ? "" : "off");
}

export const RECENT_STORE = "wh_recent";

// remember a repo for the picker's recent-first ordering: newest first,
// no duplicates, five at most
export function rememberRecent(storeKey: string, storage: StorageLike = browserStorage) {
  try {
    const recent: string[] = JSON.parse(storage.getItem(RECENT_STORE) ?? "[]");
    const next = [storeKey, ...recent.filter((r) => r !== storeKey)].slice(0, 5);
    storage.setItem(RECENT_STORE, JSON.stringify(next));
  } catch {
    // ignore
  }
}
