import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { Term } from "@/components/term";
import { TerminalChat } from "@/components/terminal-chat";
import { getSession } from "@/lib/session";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const session = await getSession();
  if (!session.token) redirect("/");
  const { owner, repo } = await params;

  return (
    <div className="mx-auto max-w-[880px] px-6 pb-10">
      <SiteHeader login={session.login} section={`${owner}/${repo}`} />
      <div className="mt-12 max-[560px]:mt-8">
        <Term title={`${owner}/${repo}`} hint="chat">
          <TerminalChat owner={owner} repo={repo} />
        </Term>
      </div>
    </div>
  );
}
