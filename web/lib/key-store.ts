// llm keys, one per provider, kept in localStorage only. the active
// provider is the one whose key goes out with the next request; its
// model override and effort level are remembered per provider too.
// a module outside react, like chat-store, so it is testable with an
// in-memory storage.

import { detectProvider, type ProviderName } from "./explain/providers";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEYS = "wd_keys";
const ACTIVE = "wd_provider";
const MODELS = "wd_models";
const EFFORTS = "wd_efforts";

// pre per-provider storage; migrated on first read
const LEGACY_KEY = "wd_key";
const LEGACY_MODEL = "wd_model";
const LEGACY_EFFORT = "wd_effort";

const ORDER: ProviderName[] = ["anthropic", "openai", "groq"];

type Slots = Partial<Record<ProviderName, string>>;

function isProvider(v: unknown): v is ProviderName {
  return typeof v === "string" && (ORDER as string[]).includes(v);
}

export function createKeyStore(storage: StorageLike) {
  const get = (k: string): string => {
    try {
      return storage.getItem(k) ?? "";
    } catch {
      return "";
    }
  };
  const set = (k: string, v: string) => {
    try {
      if (v) storage.setItem(k, v);
      else storage.removeItem(k);
    } catch {
      // private windows may block storage; the value just won't persist
    }
  };
  const getSlots = (k: string): Slots => {
    try {
      const parsed: unknown = JSON.parse(get(k) || "{}");
      if (!parsed || typeof parsed !== "object") return {};
      const out: Slots = {};
      for (const [p, v] of Object.entries(parsed)) {
        if (isProvider(p) && typeof v === "string" && v) out[p] = v;
      }
      return out;
    } catch {
      return {};
    }
  };
  const setSlots = (k: string, slots: Slots) =>
    set(k, Object.keys(slots).length ? JSON.stringify(slots) : "");
  const patch = (k: string, p: ProviderName, v: string) => {
    const slots = getSlots(k);
    if (v) slots[p] = v;
    else delete slots[p];
    setSlots(k, slots);
  };

  const migrate = () => {
    const legacy = get(LEGACY_KEY);
    if (!legacy || get(KEYS)) return;
    const p = detectProvider(legacy);
    setSlots(KEYS, { [p]: legacy });
    set(ACTIVE, p);
    const model = get(LEGACY_MODEL);
    if (model) setSlots(MODELS, { [p]: model });
    const effort = get(LEGACY_EFFORT);
    if (effort) setSlots(EFFORTS, { [p]: effort });
    set(LEGACY_KEY, "");
    set(LEGACY_MODEL, "");
    set(LEGACY_EFFORT, "");
  };

  const keys = (): Slots => {
    migrate();
    return getSlots(KEYS);
  };

  const providers = (): ProviderName[] => {
    const k = keys();
    return ORDER.filter((p) => k[p]);
  };

  const active = (): ProviderName | null => {
    const k = keys();
    const a = get(ACTIVE);
    if (isProvider(a) && k[a]) return a;
    return providers()[0] ?? null;
  };

  const setActive = (p: ProviderName) => {
    if (keys()[p]) set(ACTIVE, p);
  };

  return {
    providers,
    active,
    setActive,
    activeKey(): string {
      const a = active();
      return a ? (keys()[a] ?? "") : "";
    },
    hasKey(p: ProviderName): boolean {
      return Boolean(keys()[p]);
    },
    addKey(key: string): { provider: ProviderName; replaced: boolean } {
      const p = detectProvider(key);
      const replaced = Boolean(keys()[p]);
      patch(KEYS, p, key);
      set(ACTIVE, p);
      return { provider: p, replaced };
    },
    removeKey(p?: ProviderName) {
      if (!p) {
        set(KEYS, "");
        set(ACTIVE, "");
        set(MODELS, "");
        set(EFFORTS, "");
        return;
      }
      patch(KEYS, p, "");
      patch(MODELS, p, "");
      patch(EFFORTS, p, "");
      if (get(ACTIVE) === p) set(ACTIVE, providers()[0] ?? "");
    },
    model(p: ProviderName): string {
      migrate();
      return getSlots(MODELS)[p] ?? "";
    },
    setModel(p: ProviderName, m: string) {
      patch(MODELS, p, m);
    },
    effort(p: ProviderName): string {
      migrate();
      return getSlots(EFFORTS)[p] ?? "";
    },
    setEffort(p: ProviderName, e: string) {
      patch(EFFORTS, p, e);
    },
  };
}

export type KeyStore = ReturnType<typeof createKeyStore>;

// localStorage is absent during ssr and may throw in private windows;
// every accessor is guarded so callers just see "nothing stored"
const browserStorage: StorageLike = {
  getItem: (k) => (typeof localStorage === "undefined" ? null : localStorage.getItem(k)),
  setItem: (k, v) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(k, v);
  },
  removeItem: (k) => {
    if (typeof localStorage !== "undefined") localStorage.removeItem(k);
  },
};

export const keyStore = createKeyStore(browserStorage);
