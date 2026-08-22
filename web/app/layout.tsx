import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "wd · tiny git companion",
  description: "worktrees, minus the ceremony. diffs, in plain english.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
