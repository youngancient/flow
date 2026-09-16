import type { Metadata } from "next";
import { Newsreader, IBM_Plex_Sans } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
});

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Flow",
  description: "AI content research and publishing agent for the content team.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${plexSans.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col font-sans text-[15px]" suppressHydrationWarning>
        {/*
          Blocking, first-party, hard-coded script (never user input or
          scraped content — the "no raw HTML" security rule is about not
          rendering untrusted content, not this). Runs synchronously during
          HTML parsing, before paint, so an explicit saved theme choice
          applies with zero flash of the wrong theme — a plain useEffect in
          ThemeToggle would run after first paint and flicker.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}`,
          }}
        />
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
