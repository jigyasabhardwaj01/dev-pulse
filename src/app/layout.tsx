import type { Metadata, Viewport } from "next";
import Link from "next/link";
import NavLinks from "@/components/NavLinks";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "JARVIS", template: "%s · JARVIS" },
  description: "A weekly read on what developers are struggling with, how it is changing, and where the evidence comes from.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "light dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand" aria-label="JARVIS home">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 12h4l3-8 4 16 3-8h6" />
              </svg>
              JARVIS
            </Link>
            <NavLinks />
          </div>
        </header>
        <main id="main" className="container">{children}</main>
        <footer className="footer">
          <div className="footer-inner">
            <p>Sources: Hacker News, Stack Overflow, Reddit and GitHub Issues. Themes are assigned by Gemini Flash from a fixed list per topic.</p>
            <p>A reporting week is the seven complete days from Friday 00:00 to Thursday 23:59 IST. Trends are shown only when source coverage matches the previous week.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
