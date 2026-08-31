// the handful of ways the terminal writes a line: the echo of a command,
// a muted note, the landing's green success line, an amber error. thin
// over chat-store, built once per render with the repo's prompt.
import { chatStore, type ChatLine } from "../chat-store";

export interface Emit {
  push(rows: ChatLine[]): void;
  enter(rows: ChatLine[]): void;
  muted(texts: string[]): void;
  echo(text: string): void;
  ok(verb: string, detail?: string): void;
  err(msg: string): void;
}

export function createEmit({
  storeKey,
  prompt,
  fresh,
}: {
  storeKey: string;
  prompt: string;
  // lines that mark a state change (not streamed text, not the echo)
  // enter with a short fade; restored lines never animate
  fresh: WeakSet<ChatLine>;
}): Emit {
  const push = (rows: ChatLine[]) => chatStore.push(storeKey, rows);
  const enter = (rows: ChatLine[]) => {
    rows.forEach((r) => fresh.add(r));
    push(rows);
  };
  return {
    push,
    enter,
    muted: (texts) => enter(texts.map((text) => ({ text, cls: "o" }))),
    echo: (text) => push([{ prefix: prompt, text, cls: text.startsWith("/") ? "x" : "c" }]),
    // the landing's success line: green arrow and verb, muted detail
    ok: (verb, detail = "") =>
      enter([
        {
          head: { text: `→ ${verb}`, cls: "g" },
          text: detail ? ` ${detail}` : "",
          cls: "o",
        },
      ]),
    // errors are warnings-colored, never red: amber label, fg message
    err: (msg) => enter([{ head: { text: "error:", cls: "a" }, text: ` ${msg}`, cls: "" }]),
  };
}
