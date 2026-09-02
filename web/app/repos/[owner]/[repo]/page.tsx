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
  return { title: `${owner}/${repo} · wh` };
}

export default async function ChatPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const session = await getSession();
  // nobody types this url cold: a missing session here is an expired one
  if (!session.token) redirect("/?error=session");
  const { owner, repo } = await params;

  return (
    <AppShell login={session.login} section={`${owner}/${repo}`}>
      <TerminalChat owner={owner} repo={repo} login={session.login} />
    </AppShell>
  );
}
