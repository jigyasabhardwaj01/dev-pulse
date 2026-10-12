import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dev Pulse",
  description: "Weekly digest of what developers are struggling with, and whether it is getting louder.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">Dev Pulse</Link>
          <nav><Link href="/">This week</Link><Link href="/history">History</Link></nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
