// the models each provider offers, as last fetched by /model sync. a
// cache, never the source of truth: the shipped SUGGESTED_MODELS stay
// the seed, and any well-formed id works whether it is listed or not.
// kept apart from wh_models, which holds the user's chosen model.
import type { ProviderName } from "./explain/providers";

const CATALOG = "wh_catalog";

export interface CatalogEntry {
  models: string[];
  fetched: number;
}

type Entries = Partial<Record<ProviderName, CatalogEntry>>;

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// private windows and blocked site data throw on read and on write, so
// every access is wrapped and an absent catalog is a normal state
export function createCatalog(storage: StorageLike | null = browserStorage()) {
  function all(): Entries {
    try {
      const raw = storage?.getItem(CATALOG);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Entries;
      if (!parsed || typeof parsed !== "object") return {};
      return parsed;
    } catch {
      return {};
    }
  }

  function write(entries: Entries) {
    try {
      const keys = Object.keys(entries);
      if (keys.length === 0) storage?.removeItem(CATALOG);
      else storage?.setItem(CATALOG, JSON.stringify(entries));
    } catch {
      // nothing to do: the menu falls back to the shipped suggestions
    }
  }

  return {
    models(p: ProviderName): string[] {
      const e = all()[p];
      return Array.isArray(e?.models) ? e.models.filter((m) => typeof m === "string") : [];
    },
    fetched(p: ProviderName): number {
      return all()[p]?.fetched ?? 0;
    },
    set(p: ProviderName, models: string[]) {
      write({ ...all(), [p]: { models, fetched: Date.now() } });
    },
    clear(p: ProviderName) {
      const entries = all();
      delete entries[p];
      write(entries);
    },
  };
}

export type Catalog = ReturnType<typeof createCatalog>;
export const catalog: Catalog = createCatalog();
