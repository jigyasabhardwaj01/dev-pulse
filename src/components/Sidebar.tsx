"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark, Icon } from "./Icons";
import { NAV, SETTINGS } from "./nav";

export default function Sidebar() {
  const path = usePathname();
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <Link href="/" className="brand" aria-label="JARVIS home">
        <span className="brand-mark"><BrandMark /></span>
        <span className="brand-name">JARVIS</span>
      </Link>
      <p className="side-label" id="nav-label">Menu</p>
      <nav className="side-nav" aria-labelledby="nav-label">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={n.match(path) ? "page" : undefined}>
            <Icon name={n.icon} />{n.label}
          </Link>
        ))}
      </nav>
      <div className="side-foot">
        <Link href={SETTINGS.href} className="side-settings" aria-current={SETTINGS.match(path) ? "page" : undefined}><Icon name="settings" />{SETTINGS.label}</Link>
        <span>A weekly read on what developers struggle with, built from public discussions.</span>
      </div>
    </aside>
  );
}
