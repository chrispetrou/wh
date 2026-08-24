// per-repo chat state living outside react, so a streaming explain keeps
// flowing while another tab is in the foreground. persisted to
// sessionStorage (200-line cap) exactly like the old in-component state.

export interface ChatLine {
  text: string;
  cls: string;
  prefix?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface Entry {
  lines: ChatLine[];
  streaming: boolean;
  startedAt: number;
  loaded: boolean;
  abort?: AbortController;
  // follow-up context: alternating user/assistant, [0] is the payload
  context?: ChatMessage[];
  // branch names for completion, default branch first
  branches?: string[];
}

const MAX_CONTEXT_MESSAGES = 26;
const MAX_CONTEXT_CHARS = 400_000;

const LIMIT = 200;
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY: ChatLine[] = [];

function entry(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = { lines: EMPTY, streaming: false, startedAt: 0, loaded: false };
    entries.set(key, e);
  }
  return e;
}

function load(key: string): Entry {
  const e = entry(key);
  if (e.loaded) return e;
  e.loaded = true;
  try {
    const s = sessionStorage.getItem(`wd_log:${key}`);
    if (s) {
      const p = JSON.parse(s) as ChatLine[];
      if (Array.isArray(p)) e.lines = p;
    }
  } catch {
    // ignore
  }
  return e;
}

function persist(key: string) {
  try {
    const e = entry(key);
    if (e.lines.length) {
      sessionStorage.setItem(`wd_log:${key}`, JSON.stringify(e.lines.slice(-LIMIT)));
    } else {
      sessionStorage.removeItem(`wd_log:${key}`);
    }
  } catch {
    // ignore
  }
}

function emit(key: string) {
  listeners.get(key)?.forEach((f) => f());
}

export const chatStore = {
  subscribe(key: string, cb: () => void): () => void {
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  },
  lines(key: string): ChatLine[] {
    return load(key).lines;
  },
  emptyLines(): ChatLine[] {
    return EMPTY;
  },
  push(key: string, rows: ChatLine[]) {
    const e = load(key);
    e.lines = [...e.lines, ...rows].slice(-LIMIT);
    persist(key);
    emit(key);
  },
  setAll(key: string, lines: ChatLine[]) {
    const e = load(key);
    e.lines = lines;
    persist(key);
    emit(key);
  },
  streaming(key: string): boolean {
    return entry(key).streaming;
  },
  startedAt(key: string): number {
    return entry(key).startedAt;
  },
  setStreaming(key: string, on: boolean, abort?: AbortController) {
    const e = entry(key);
    e.streaming = on;
    e.startedAt = on ? Date.now() : 0;
    e.abort = on ? abort : undefined;
    emit(key);
  },
  abort(key: string) {
    entry(key).abort?.abort();
  },
  context(key: string): ChatMessage[] | undefined {
    return entry(key).context;
  },
  branchList(key: string): string[] | undefined {
    return entry(key).branches;
  },
  setBranches(key: string, branches: string[]) {
    entry(key).branches = branches;
    emit(key);
  },
  setContext(key: string, firstUser: string, firstAnswer: string) {
    entry(key).context = [
      { role: "user", content: firstUser },
      { role: "assistant", content: firstAnswer },
    ];
    emit(key);
  },
  clearContext(key: string) {
    entry(key).context = undefined;
    emit(key);
  },
  appendExchange(key: string, question: string, answer: string) {
    const e = entry(key);
    if (!e.context) return;
    let next = [
      ...e.context,
      { role: "user" as const, content: question },
      { role: "assistant" as const, content: answer },
    ];
    // trim middle pairs first; the payload pair at [0..1] must survive
    const size = () => next.reduce((n, m) => n + m.content.length, 0);
    while (next.length > MAX_CONTEXT_MESSAGES || size() > MAX_CONTEXT_CHARS) {
      if (next.length <= 4) break;
      next = [...next.slice(0, 2), ...next.slice(4)];
    }
    e.context = next;
    emit(key);
  },
};
