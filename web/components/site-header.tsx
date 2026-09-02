import Link from "next/link";
import { Glyph } from "./glyph";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader({
  login,
  section,
}: {
  login?: string;
  section?: string;
}) {
  return (
    <header className="pt-7">
      <div className="flex items-center gap-7">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link href="/" className="flex items-center gap-2.5 font-semibold">
            <Glyph /> <span>wh</span>
          </Link>
          <span className="font-normal text-wh-faint">/</span>
          {section ? (
            <span className="truncate text-muted-foreground">{section}</span>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-5 text-muted-foreground">
          <ThemeToggle />
          {login ? (
            <>
              <span className="hidden max-w-32 truncate sm:inline">{login}</span>
              <form action="/api/auth/logout" method="post">
                <button type="submit" className="cursor-pointer hover:text-foreground">
                  logout
                </button>
              </form>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
