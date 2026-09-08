// a fixture render of the stat block (who, churn, activity), for
// eyeballing bars and the sparkline without a github session. only
// served when WH_PREVIEW=1 is set.
import { notFound } from "next/navigation";
import { PreviewStat } from "./preview";
import { previewTheme } from "../theme";

// decided per request, never baked in at build time
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string }>;
}) {
  if (process.env.WH_PREVIEW !== "1") notFound();
  const { theme } = await searchParams;
  return <PreviewStat theme={previewTheme(theme)} />;
}
