import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { RepoPicker } from "@/components/repo-picker";
import { GithubError, listRepos } from "@/lib/github";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "repos · wh" };

export default async function ReposPage() {
  const session = await getSession();
  if (!session.token) redirect("/?error=session");

  let repos;
  try {
    repos = await listRepos(session.token);
  } catch (e) {
    if (e instanceof GithubError && e.status === 401) redirect("/api/auth/reset");
    throw e;
  }

  return (
    <AppShell login={session.login} section="repos">
      <RepoPicker repos={repos} />
    </AppShell>
  );
}
