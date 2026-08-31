"use client";

// one transcript line as text: the head, text, and tail spans in their
// colors, with urls in the output turned into quiet accent links.

import type { ChatLine, Cls } from "@/lib/chat-store";
import { URL_RE } from "@/lib/terminal/lines";

export const CLS: Record<Cls, string> = {
  p: "text-muted-foreground",
  c: "font-semibold",
  o: "text-muted-foreground",
  g: "text-wd-green",
  a: "text-wd-amber",
  x: "text-wd-accent",
  r: "text-destructive",
  f: "text-wd-faint",
  "": "",
};

export function renderText(text: string) {
  const parts = text.split(URL_RE);
  const urls = text.match(URL_RE);
  if (!urls) return text;
  const out: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    out.push(part);
    const url = urls[i];
    if (url) {
      out.push(
        <a
          key={i}
          href={url.startsWith("http") ? url : `https://${url}`}
          target="_blank"
          rel="noreferrer"
          className="text-wd-accent underline decoration-wd-faint underline-offset-2 hover:decoration-wd-accent"
        >
          {url}
        </a>
      );
    }
  });
  return out;
}

export function LineText({ line }: { line: ChatLine }) {
  return (
    <>
      {line.head ? <span className={CLS[line.head.cls]}>{line.head.text}</span> : null}
      <span className={CLS[line.cls]}>{renderText(line.text)}</span>
      {line.tail ? <span className={CLS[line.tail.cls]}>{line.tail.text}</span> : null}
    </>
  );
}
