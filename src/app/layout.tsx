import type { Metadata, Viewport } from "next";
import MobileBar from "@/components/MobileBar";
import Sidebar from "@/components/Sidebar";
import { THEME_BOOT, ThemeSync } from "@/components/ThemeToggle";
import TopBar from "@/components/TopBar";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "JARVIS", template: "%s · JARVIS" },
  description: "A weekly read on what developers are struggling with, how it is changing, and where the evidence comes from.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "dark light", themeColor: "#07040b" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} /></head>
      <body>
        <ThemeSync />
        <a className="skip" href="#main">Skip to content</a>
        <div className="app">
          <Sidebar />
          <div className="main-col">
            <MobileBar />
            <TopBar />
            <main id="main" className="page">{children}</main>
            <footer className="footer">
              <p>Sources: Hacker News, Stack Overflow, Reddit and GitHub Issues. Themes are assigned by Gemini Flash from a fixed list per topic.</p>
              <p>A reporting week is the seven complete days from Friday 00:00 to Thursday 23:59 IST. Trends are shown only when source coverage matches the previous week.</p>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
