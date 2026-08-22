import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { getSession } from "@/lib/session";

const ERRORS: Record<string, string> = {
  auth: "sign-in failed, try again.",
  session: "session expired, sign in again.",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (session.token) redirect("/repos");
  const { error } = await searchParams;

  return (
    <div className="mx-auto max-w-[880px] px-6">
      <SiteHeader />
      <section className="pt-[88px] max-[560px]:pt-14">
        <p>Ask questions about any repo. Explained in plain english.</p>
        <p className="mt-4 text-muted-foreground">
          pick a repo, then: explain the last 5 commits, what changed in pr
          #42, diff main..release. answers run on your own llm key.
        </p>
        {error && ERRORS[error] ? (
          <p className="mt-4 text-muted-foreground">{ERRORS[error]}</p>
        ) : null}
        <p className="mt-7">
          <a
            href="/api/auth/login"
            className="border-b border-border pb-0.5 font-semibold hover:border-foreground"
          >
            sign in with github <span className="text-wd-green">→</span>
          </a>
        </p>
      </section>
    </div>
  );
}
