"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { RepoItem } from "@/lib/github";
import { relTime } from "@/lib/utils";
import { RECENT_STORE } from "@/lib/terminal/prefs";

// the recent list is read once per page view; the server renders the
// api order and the client pass re-sorts, so nothing sets state on mount
const noResort = () => () => {};
const readRecent = () => {
  try {
    return localStorage.getItem(RECENT_STORE) ?? "[]";
  } catch {
    return "[]";
  }
};

export function RepoPicker({ repos }: { repos: RepoItem[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const rowsRef = useRef<HTMLDivElement>(null);

  // recently opened repos float to the top (stable for the rest)
  const recentRaw = useSyncExternalStore(noResort, readRecent, () => "[]");
  const ordered = useMemo(() => {
    try {
      const recent: string[] = JSON.parse(recentRaw);
      if (!recent.length) return repos;
      const rank = new Map(recent.map((name, i) => [name, i]));
      return [...repos].sort(
        (a, b) =>
          (rank.get(a.fullName) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.fullName) ?? Number.MAX_SAFE_INTEGER)
      );
    } catch {
      return repos;
    }
  }, [recentRaw, repos]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return ordered.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [ordered, query]);
  const selected = Math.min(sel, Math.max(filtered.length - 1, 0));

  // keep the keyboard selection visible inside the scrolling list
  useEffect(() => {
    rowsRef.current
      ?.querySelector(".row-sel")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const open = (r: RepoItem) => router.push(`/repos/${r.owner}/${r.name}`);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(Math.min(selected + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(Math.max(selected - 1, 0));
    } else if (e.key === "Enter" && filtered[selected]) {
      e.preventDefault();
      open(filtered[selected]);
    }
  };

  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className="page-in flex min-h-0 flex-1 flex-col"
      onClick={() => {
        if (!window.getSelection()?.toString()) inputRef.current?.focus();
      }}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-muted-foreground">? select repo</span>
        <input
          ref={inputRef}
          className="term-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="filter repositories"
        />
      </div>
      <div ref={rowsRef} className="term-scroll mt-2">
        {filtered.length === 0 ? (
          <div className="text-muted-foreground">  no match</div>
        ) : (
          filtered.map((r, i) => (
            <button
              key={r.fullName}
              type="button"
              onClick={() => open(r)}
              onMouseEnter={() => setSel(i)}
              className={`picker-row flex w-full cursor-pointer items-baseline gap-3 rounded-[3px] px-1 py-0.5 text-left ${
                i === selected ? "row-sel" : ""
              }`}
            >
              <span className="shrink-0">{i === selected ? "›" : " "}</span>
              <span className="min-w-0 flex-1 truncate">
                {r.fullName}
                {r.private ? (
                  <span className="text-muted-foreground"> private</span>
                ) : null}
              </span>
              <span className="shrink-0 text-muted-foreground">
                ·  {relTime(r.pushedAt)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
