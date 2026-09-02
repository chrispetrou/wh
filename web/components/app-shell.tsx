import Link from "next/link";
import type { ReactNode } from "react";
import { Glyph } from "./glyph";
import { TabBar } from "./tab-bar";
import { ThemeToggle } from "./theme-toggle";
import { TipLayer } from "./tip-layer";
import { ViewportVar } from "./viewport-var";

// full-bleed app surface: slim top bar, content fills the viewport.
// the page never scrolls; scrolling happens inside the content.
export function AppShell({
  login,
  section,
  children,
}: {
  login?: string;
  section?: string;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <ViewportVar />
      <TipLayer />
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border px-6 py-3">
        <Link
          href="/repos"
          data-tip="back to repos · cmd+k"
          className="flex items-center gap-2.5 font-semibold"
        >
          <Glyph /> <span>wh</span>
        </Link>
        <span className="font-normal text-wh-faint">/</span>
        {section ? (
          <span className="min-w-0 truncate text-muted-foreground">{section}</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-5 text-muted-foreground">
          <ThemeToggle />
          {login ? (
            <>
              <span className="hidden max-w-32 truncate sm:inline">{login}</span>
              <form action="/api/auth/logout" method="post">
                <button
                  type="submit"
                  data-tip="sign out (also /logout in the chat)"
                  className="cursor-pointer hover:text-foreground"
                >
                  logout
                </button>
              </form>
            </>
          ) : null}
        </div>
      </header>
      <TabBar />
      <main className="app-main flex min-h-0 flex-1 flex-col px-6 py-4">
        {children}
      </main>
    </div>
  );
}
