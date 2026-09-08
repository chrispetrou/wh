// a fixture render of the file view block, for eyeballing highlighting,
// the mark, and the loading state without a github session. only served
// when WH_PREVIEW=1 is set.
import { notFound } from "next/navigation";
import { PreviewView } from "./preview";
import { previewTheme } from "../theme";

// decided per request, never baked in at build time
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string; open?: string; mark?: string }>;
}) {
  if (process.env.WH_PREVIEW !== "1") notFound();
  const { theme, open, mark } = await searchParams;
  return (
    <PreviewView
      theme={previewTheme(theme)}
      loading={open === "loading"}
      mark={mark ? parseInt(mark, 10) : undefined}
    />
  );
}
