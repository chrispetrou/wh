"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RepoItem } from "@/lib/github";

function relTime(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(iso)
    .toLocaleDateString("en-GB", { month: "short", day: "numeric" })
    .toLowerCase();
}

export function RepoPicker({ repos }: { repos: RepoItem[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const rowsRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repos, query]);
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

  return (
    <div className="term-fill">
      <div className="flex items-baseline gap-2">
        <span className="text-muted-foreground">? select repo</span>
        <input
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
                  <span className="text-wd-faint"> private</span>
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
