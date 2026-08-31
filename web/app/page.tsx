import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { getSession } from "@/lib/session";
import { oauthConfigured, setupAllowed } from "@/lib/setup";

const ERRORS: Record<string, string> = {
  auth: "sign-in failed, try again.",
  session: "session expired, sign in again.",
  config: "github oauth is not configured on this server.",
  setup: "that did not look like a client id and secret, try again.",
};

function SetupBlock({ origin }: { origin: string }) {
  const params = new URLSearchParams({
    "oauth_application[name]": "wd (dev)",
    "oauth_application[url]": origin,
    "oauth_application[callback_url]": `${origin}/api/auth/callback`,
  });
  const newAppUrl = `https://github.com/settings/applications/new?${params}`;
  return (
    <div className="mt-8 max-w-[560px]">
      <p className="text-muted-foreground">
        one-time setup: wd needs a github oauth app to sign people in.
      </p>
      <p className="mt-4">
        1.{" "}
        <a
          href={newAppUrl}
          target="_blank"
          rel="noreferrer"
          className="border-b border-border pb-0.5 font-semibold hover:border-foreground"
        >
          create the oauth app <span className="text-wd-green">→</span>
        </a>{" "}
        <span className="text-muted-foreground">
          (the form comes prefilled, just register it)
        </span>
      </p>
      <p className="mt-2 text-muted-foreground">
        2. generate a client secret on the app page, paste both here:
      </p>
      <form action="/api/setup" method="post" className="mt-4 flex flex-col gap-3">
        <label className="flex items-baseline gap-3">
          <span className="w-28 shrink-0 text-muted-foreground">client id</span>
          <input
            name="client_id"
            required
            placeholder="Ov23li..."
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="field-input"
          />
        </label>
        <label className="flex items-baseline gap-3">
          <span className="w-28 shrink-0 text-muted-foreground">client secret</span>
          <input
            name="client_secret"
            type="password"
            required
            placeholder="paste the generated secret"
            className="field-input"
          />
        </label>
        <button
          type="submit"
          className="mt-2 w-fit cursor-pointer border-b border-border pb-0.5 font-semibold hover:border-foreground"
        >
          save and sign in <span className="text-wd-green">→</span>
        </button>
      </form>
      <p className="mt-4 text-muted-foreground">
        saved to web/.env.local on this machine, nowhere else.
      </p>
    </div>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession().catch(() => null);
  if (session?.token) redirect("/repos");
  const { error } = await searchParams;
  const hdrs = await headers();
  const host = hdrs.get("host");
  const needsSetup = !oauthConfigured();

  return (
    <div className="mx-auto max-w-[880px] px-6 pb-10">
      <SiteHeader />
      <section className="page-in pt-[88px] max-[560px]:pt-14">
        <p>ask questions about any repo. explained in plain english.</p>
        <p className="mt-4 text-muted-foreground">
          pick a repo, then: explain the last 5 commits, what changed in pr
          #42, diff main..release. answers run on your own llm key.
        </p>
        {error && ERRORS[error] ? (
          <p className="mt-4 text-muted-foreground">{ERRORS[error]}</p>
        ) : null}
        {needsSetup ? (
          setupAllowed(hdrs) ? (
            <SetupBlock origin={`http://${host}`} />
          ) : (
            <p className="mt-4 text-muted-foreground">
              github oauth is not configured on this server.
            </p>
          )
        ) : (
          <p className="mt-7">
            <a
              href="/api/auth/login"
              className="border-b border-border pb-0.5 font-semibold hover:border-foreground"
            >
              sign in with github <span className="text-wd-green">→</span>
            </a>
          </p>
        )}
      </section>
    </div>
  );
}
