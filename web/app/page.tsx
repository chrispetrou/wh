import Link from "next/link";

// the logo glyph is the clip-path square from site/index.html
function Glyph() {
  return (
    <span
      aria-hidden
      className="inline-block size-3.5 bg-foreground"
      style={{
        clipPath: "polygon(0 0, 100% 0, 100% 100%, 35% 100%, 35% 35%, 0 35%)",
      }}
    />
  );
}

export default function Home() {
  return (
    <div className="mx-auto max-w-[880px] px-6">
      <header className="pt-7">
        <div className="flex items-center gap-7">
          <Link href="/" className="flex items-center gap-2.5 font-semibold">
            <Glyph /> <span>wd</span>{" "}
            <span className="font-normal text-wd-faint">/</span>
          </Link>
          <nav className="flex gap-5 text-muted-foreground">
            <Link href="/" className="hover:text-foreground">
              try
            </Link>
          </nav>
        </div>
      </header>

      <section className="pt-[88px]">
        <p>Ask questions about any repo. Coming soon.</p>
        <p className="mt-4 text-muted-foreground">
          github sign-in, a repo picker, and a terminal-flavored chat that
          explains commits, PRs, and diffs in plain english.
        </p>
      </section>
    </div>
  );
}
