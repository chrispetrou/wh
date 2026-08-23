import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { TerminalChat } from "@/components/terminal-chat";
import { getSession } from "@/lib/session";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}): Promise<Metadata> {
  const { owner, repo } = await params;
  return { title: `${owner}/${repo} · wd` };
}

export default async function ChatPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const session = await getSession();
  if (!session.token) redirect("/");
  const { owner, repo } = await params;

  return (
    <AppShell login={session.login} section={`${owner}/${repo}`}>
      <TerminalChat owner={owner} repo={repo} login={session.login} />
    </AppShell>
  );
}
