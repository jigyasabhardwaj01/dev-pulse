"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark, Icon } from "./Icons";
import { NAV } from "./nav";

export default function Sidebar() {
  const path = usePathname();
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <Link href="/" className="brand" aria-label="JARVIS home">
        <span className="brand-mark"><BrandMark /></span>
        <span className="brand-name">JARVIS</span>
      </Link>
      <p className="side-label" id="nav-label">Workspace</p>
      <nav className="side-nav" aria-labelledby="nav-label">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={n.match(path) ? "page" : undefined}>
            <Icon name={n.icon} />{n.label}
          </Link>
        ))}
      </nav>
      <div className="side-foot">
        <strong>Reporting week</strong>
        <span>Seven complete days, Friday 00:00 to Thursday 23:59 IST.</span>
        <span>Themes assigned by Gemini Flash via OpenRouter.</span>
      </div>
    </aside>
  );
}
