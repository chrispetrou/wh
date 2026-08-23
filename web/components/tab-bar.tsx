"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const TABS_STORE = "wd_tabs";

function readTabs(): string[] {
  try {
    const t = JSON.parse(sessionStorage.getItem(TABS_STORE) ?? "[]");
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}

function writeTabs(tabs: string[]) {
  try {
    sessionStorage.setItem(TABS_STORE, JSON.stringify(tabs));
  } catch {
    // ignore
  }
}

function activeRepo(pathname: string): string | null {
  const m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(pathname);
  return m ? `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}` : null;
}

export function TabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [tabs, setTabs] = useState<string[]>([]);
  const active = activeRepo(pathname);

  // load, and register the repo being viewed as a tab
  useEffect(() => {
    let next = readTabs();
    if (active && !next.includes(active)) {
      next = [...next, active];
      writeTabs(next);
    }
    setTabs(next);
  }, [active]);

  // ctrl+t opens the picker for a new tab; ctrl+1..9 switch tabs
  // (cmd+t and cmd+digits belong to the browser)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "t") {
        e.preventDefault();
        router.push("/repos");
      } else if (e.key >= "1" && e.key <= "9") {
        const t = tabs[parseInt(e.key, 10) - 1];
        if (t) {
          e.preventDefault();
          router.push(`/repos/${t}`);
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [tabs, router]);

  const close = (t: string) => {
    const next = tabs.filter((x) => x !== t);
    writeTabs(next);
    setTabs(next);
    if (t === active) {
      router.push(next.length ? `/repos/${next[next.length - 1]}` : "/repos");
    }
  };

  if (tabs.length === 0) return null;

  // repo name alone, unless two open tabs share it
  const label = (t: string) => {
    const name = t.split("/")[1] ?? t;
    const dupes = tabs.filter((x) => (x.split("/")[1] ?? x) === name);
    return dupes.length > 1 ? t : name;
  };

  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4 py-1.5 text-[12px]">
      {tabs.map((t) => (
        <span
          key={t}
          className={`flex shrink-0 items-center gap-2 rounded-[3px] px-2 py-0.5 ${
            t === active
              ? "row-sel font-semibold"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Link href={`/repos/${t}`} title={t}>
            {label(t)}
          </Link>
          <button
            type="button"
            aria-label={`close ${t}`}
            onClick={() => close(t)}
            className="cursor-pointer text-wd-faint hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}
      <Link
        href="/repos"
        title="new tab (ctrl+t)"
        className="shrink-0 px-2 py-0.5 text-wd-faint hover:text-foreground"
      >
        +
      </Link>
    </div>
  );
}
