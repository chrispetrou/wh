// the terminal's line shapes: how streamed text becomes colored rows
// (diff lines, section labels, the branches and tags listings, the
// [wd:...] sentinels the route appends), and how a row goes back to
// plain text for /copy and /export. no react, no store.
import { blockText } from "../block";
import type { ChatLine, Head } from "../chat-store";
import type { Left } from "../key-store";
import { relTime } from "../utils";

// a line as plain text, for /copy and /export
export function flat(l: ChatLine): string {
  if (l.block) return blockText(l.block).join("\n");
  return (
    (l.prefix ? `${l.prefix} ` : "") + (l.head?.text ?? "") + l.text + (l.tail?.text ?? "")
  );
}

// a branches row: "3  feat/web_app    behind 1". like the landing picker
// and wd ls, the name is fg and the index and status words are muted
const BRANCH_ROW = /^(\s*\d+\s{2})(\S+)(.*)$/;

export function branchLine(text: string): ChatLine {
  const m = BRANCH_ROW.exec(text);
  if (!m) return { text, cls: "o" }; // the count and note lines
  return {
    head: { text: m[1], cls: "o" },
    text: m[2],
    cls: "",
    tail: { text: m[3], cls: "o" },
    drop: `branch:${m[2]}`, // a log row dropped here is picked onto it
  };
}

// a tags row: "2\tv1.10  \ta1b2c3d\t<iso>"; the name is fg, the rest muted,
// the date relative like the picker
export function tagLine(text: string): ChatLine {
  const f = text.split("\t");
  if (f.length < 4) return { text, cls: "o" };
  const [num, name, sha, iso] = f;
  return {
    head: { text: `${num}  `, cls: "o" },
    text: name,
    cls: "",
    tail: { text: `${sha}${iso ? `  ${relTime(iso)}` : ""}`, cls: "o" },
  };
}

// the section labels of every output contract, painted amber
export const LABELS = new Set([
  "summary",
  "watch out",
  "added",
  "changed",
  "fixed",
  "removed",
  "title",
  "description",
  "testing",
  "why",
  "subject",
  "body",
]);

// urls in output become quiet accent links
export const URL_RE = /\bhttps?:\/\/[^\s]+|\bgithub\.com\/[^\s]+/g;

// what the stream is showing right now: model text, a raw payload
// (/show), or one of the two listings with their own row shapes
export type StreamMode = "text" | "diff" | "branches" | "tags";

export function classify(mode: StreamMode, text: string): ChatLine {
  const t = text.trimEnd();
  if (mode === "branches") return branchLine(t);
  if (mode === "tags") return tagLine(t);
  if (mode === "diff") {
    if (t.startsWith("diff --git")) return { text, cls: "c" };
    if (t.startsWith("- ")) return { text, cls: "o" }; // payload commit list
    if (t.startsWith("+++") || t.startsWith("---")) return { text, cls: "o" };
    if (t.startsWith("@@")) return { text, cls: "x" };
    if (t.startsWith("+")) return { text, cls: "g" };
    if (t.startsWith("-")) return { text, cls: "r" };
    if (t.startsWith("...")) return { text, cls: "o" };
    return { text, cls: "" };
  }
  if (LABELS.has(t)) return { text, cls: "a" };
  if (t.startsWith("[wd:error] ")) {
    const head: Head = { text: "error:", cls: "a" };
    return { head, text: ` ${t.slice(11)}`, cls: "" };
  }
  if (t.startsWith("[wd:hint] ")) return { text: t.slice(10), cls: "o" };
  return { text, cls: "" };
}

// what the route said the answer cost, parsed from its [wd:usage] line
export interface UsageSentinel {
  in?: number;
  out?: number;
  left?: Left | null;
}

// the stream assembler: chunks in, complete rows out. the answer's own
// lines are kept for the follow-up context; the [wd:...] sentinel lines
// the route appends are taken aside and are not part of it
export function createAssembler() {
  let mode: StreamMode = "text";
  let partial = "";
  let answer = "";
  let usage: UsageSentinel | null = null;

  // every complete line passes here: sentinels are taken aside (nothing
  // to show), the rest is kept for the context and returned to show
  const sink = (line: string, complete: boolean): ChatLine | null => {
    if (line.startsWith("[wd:usage] ")) {
      try {
        usage = JSON.parse(line.slice(11));
      } catch {
        // a bad sentinel is nothing to show
      }
      return null;
    }
    if (!line.startsWith("[wd:")) answer += complete ? `${line}\n` : line;
    return classify(mode, line);
  };

  return {
    get mode() {
      return mode;
    },
    set mode(m: StreamMode) {
      mode = m;
    },
    // the complete rows in a chunk; the trailing fragment waits
    feed(chunk: string): ChatLine[] {
      partial += chunk;
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      return parts.map((p) => sink(p, true)).filter((l): l is ChatLine => l !== null);
    },
    // the fragment left after the last newline, once the stream ends
    flush(): ChatLine | null {
      if (!partial) return null;
      const row = sink(partial, false);
      partial = "";
      return row;
    },
    answer(): string {
      return answer;
    },
    takeUsage(): UsageSentinel | null {
      const u = usage;
      usage = null;
      return u;
    },
    // a new stream starts with an empty answer and no cost; a fragment
    // left by a stream that was cut short stays, as it always has
    reset(m: StreamMode) {
      answer = "";
      usage = null;
      mode = m;
    },
  };
}

export type Assembler = ReturnType<typeof createAssembler>;
