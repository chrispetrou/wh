import type { Metadata, Viewport } from "next";
import { Fira_Code, IBM_Plex_Mono, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

// optional terminal fonts, self-hosted at build time (/font to switch)
const fira = Fira_Code({ subsets: ["latin"], variable: "--font-fira", display: "swap" });
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});
const plex = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-plex",
  display: "swap",
});

export const metadata: Metadata = {
  title: "wd · tiny git companion",
  description: "worktrees, minus the ceremony. diffs, in plain english.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d0d" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // set by the middleware; the boot script must carry it or the csp
  // blocks the one inline script we actually want
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fira.variable} ${jetbrains.variable} ${plex.variable}`}
    >
      <body className="antialiased">
        <script
          nonce={nonce}
          // apply stored preferences before paint so there is no flash
          dangerouslySetInnerHTML={{
            __html: `try{var d=document.documentElement,g=function(k){return localStorage.getItem(k)};
var t=g("wd_theme");if(t==="dark"||t==="light")d.classList.add(t);
var f=g("wd_font");if(f)d.setAttribute("data-font",f);
var s=g("wd_fontsize");if(s)d.style.setProperty("--wd-font-size",s+"px");
if(g("wd_lig")==="off")d.setAttribute("data-lig","off")}catch(e){}`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
