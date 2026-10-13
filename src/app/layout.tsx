import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Inter_Tight, JetBrains_Mono } from "next/font/google";
import MotionRuntime from "@/components/MotionRuntime";
import SiteFooter from "@/components/SiteFooter";
import MobileBar from "@/components/MobileBar";
import Sidebar from "@/components/Sidebar";
import { THEME_BOOT, ThemeSync } from "@/components/ThemeToggle";
import TopBar from "@/components/TopBar";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "JARVIS", template: "%s · JARVIS" },
  description: "A weekly read on what developers are struggling with, how it is changing, and where the evidence comes from.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "light dark", themeColor: "#e9e8e4" };

// Self-hosted at build time by next/font: no request to Google from the visitor's browser, and no layout shift.
const sans = Inter_Tight({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} /></head>
      <body>
        <ThemeSync />
        <a className="skip" href="#main">Skip to content</a>
        <MotionRuntime />
        <div className="app">
          <header className="shell-top">
            <Sidebar />
            <TopBar />
          </header>
          <MobileBar />
          <main id="main" className="page">{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
