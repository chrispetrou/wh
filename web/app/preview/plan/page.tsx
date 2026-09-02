// a fixture render of a rebase plan, for eyeballing the block without a
// github session. only served when WH_PREVIEW=1 is set.
import { notFound } from "next/navigation";
import { PreviewPlan } from "./preview";

// decided per request, never baked in at build time
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string; open?: string }>;
}) {
  if (process.env.WH_PREVIEW !== "1") notFound();
  const { theme, open } = await searchParams;
  return <PreviewPlan dark={theme === "dark"} open={open === "1"} />;
}
