import { redirect } from "next/navigation";
import { RepoPicker } from "@/components/repo-picker";
import { SiteHeader } from "@/components/site-header";
import { Term } from "@/components/term";
import { GithubError, listRepos } from "@/lib/github";
import { getSession } from "@/lib/session";

export default async function ReposPage() {
  const session = await getSession();
  if (!session.token) redirect("/");

  let repos;
  try {
    repos = await listRepos(session.token);
  } catch (e) {
    if (e instanceof GithubError && e.status === 401) redirect("/api/auth/reset");
    throw e;
  }

  return (
    <div className="mx-auto max-w-[880px] px-6 pb-10">
      <SiteHeader login={session.login} />
      <div className="mt-12 max-[560px]:mt-8">
        <Term title="wd" hint="repos">
          <RepoPicker repos={repos} />
        </Term>
      </div>
    </div>
  );
}
