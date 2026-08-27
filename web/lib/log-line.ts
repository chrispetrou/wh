// lays out one log row for the transcript. a row arrives from the server
// as tab-separated fields (rails, sha, refs, subject, author, iso date); a
// connector row has rails only; footer lines carry no tabs and stay muted.
// commit rows are numbered as they pass, so `explain 3` means the third
// commit on screen.
import type { ChatLine } from "./chat-store";
import { relTime } from "./utils";

export interface LogLayout {
  n: number; // commit rows numbered so far
  width: number; // digits in the number column
  rails: number; // rail column width
}

// the row budget before the author and date stop lining up
export const LOG_COLS = 100;

// a pr row: "#12 \talice\ttitle\thead → base\tiso\tflags" (number and author
// padded by the server). the number is accent so it reads as the thing
// to type next (`pr 12`); the title is fg; branches, age, state muted
export function prLine(text: string, now = Date.now()): ChatLine {
  const f = text.split("\t");
  if (f.length < 6) return { text, cls: "o" };
  const [num, author, title, branches, iso, flags] = f;
  const meta = ` ${branches} ${relTime(iso, now)}${flags ? ` · ${flags}` : ""}`;
  const used = num.length + 1 + author.length + 1;
  const room = LOG_COLS - used - meta.length;
  let t = title;
  if (room >= 12) {
    if (t.length > room) t = t.slice(0, room - 1) + "…";
    t = t.padEnd(room);
  }
  return {
    text: "",
    cls: "",
    pre: true,
    spans: [
      { text: `${num} `, cls: "x" },
      { text: `${author} `, cls: "o" },
      { text: t, cls: "" },
      { text: meta, cls: "o" },
    ],
  };
}

export function logLine(text: string, st: LogLayout, now = Date.now()): ChatLine {
  const f = text.split("\t");
  if (f.length < 6) return { text, cls: "o" };
  const [rails, sha, refs, subject, author, date] = f;
  const num = sha ? String(++st.n).padStart(st.width) : " ".repeat(st.width);
  const spans = [
    { text: `${num} `, cls: "o" },
    { text: rails.padEnd(st.rails), cls: "f" },
  ];
  if (!sha) return { text: "", cls: "", spans, pre: true };
  spans.push({ text: ` ${sha} `, cls: "o" });
  let used = st.width + 1 + st.rails + 1 + 7 + 1;
  if (refs) {
    spans.push({ text: `${refs} `, cls: "x" });
    used += refs.length + 1;
  }
  const meta = ` ${author} ${relTime(date, now)}`;
  const room = LOG_COLS - used - meta.length;
  let subj = subject;
  // long refs squeeze the subject; below 12 columns the row just runs on
  if (room >= 12) {
    if (subj.length > room) subj = subj.slice(0, room - 1) + "…";
    subj = subj.padEnd(room);
  }
  spans.push({ text: subj, cls: "" }, { text: meta, cls: "o" });
  return { text: "", cls: "", spans, pre: true };
}
