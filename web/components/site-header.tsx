import Link from "next/link";
import { Glyph } from "./glyph";

export function SiteHeader({ login }: { login?: string }) {
  return (
    <header className="pt-7">
      <div className="flex items-center gap-7">
        <Link href="/" className="flex items-center gap-2.5 font-semibold">
          <Glyph /> <span>wd</span>{" "}
          <span className="font-normal text-wd-faint">/</span>
        </Link>
        <div className="ml-auto flex items-center gap-5 text-muted-foreground">
          {login ? (
            <>
              <span className="max-w-32 truncate">{login}</span>
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
