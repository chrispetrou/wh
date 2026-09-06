// a fixture render of a rebase plan, for eyeballing the block without a
// github session. only served when WH_PREVIEW=1 is set.
import { notFound } from "next/navigation";
import { PreviewPlan } from "./preview";
import { previewTheme } from "../theme";

// decided per request, never baked in at build time
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string; open?: string }>;
}) {
  if (process.env.WH_PREVIEW !== "1") notFound();
  const { theme, open } = await searchParams;
  return <PreviewPlan theme={previewTheme(theme)} open={open === "1"} />;
}
