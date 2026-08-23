import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "wd · tiny git companion",
  description: "worktrees, minus the ceremony. diffs, in plain english.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <script
          // apply the stored theme before paint so there is no flash
          dangerouslySetInnerHTML={{
            __html:
              'try{var t=localStorage.getItem("wd_theme");if(t==="dark"||t==="light")document.documentElement.classList.add(t)}catch(e){}',
          }}
        />
        {children}
      </body>
    </html>
  );
}
