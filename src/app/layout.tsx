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
              <p>JARVIS reads public developer discussions (Hacker News, Stack Overflow and GitHub Issues) and groups them into recurring problems. Counts are a sample of what is public, not every developer.</p>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
