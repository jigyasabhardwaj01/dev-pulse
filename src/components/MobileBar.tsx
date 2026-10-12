"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BrandMark, Icon } from "./Icons";
import { MOBILE_MORE, MOBILE_PRIMARY } from "./nav";
import ThemeToggle from "./ThemeToggle";

/** Compact top bar for narrow screens: the three most useful destinations, plus a menu for the rest. */
export default function MobileBar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const click = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", key); document.addEventListener("mousedown", click);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("mousedown", click); };
  }, [open]);
  const moreActive = MOBILE_MORE.some((n) => n.match(path));
  return (
    <div className="mtop" ref={box}>
      <Link href="/" className="brand" aria-label="JARVIS home"><span className="brand-mark"><BrandMark /></span><span className="brand-name">JARVIS</span></Link>
      <nav className="mtabs" aria-label="Main">
        {MOBILE_PRIMARY.map((n) => (
          <Link key={n.href} href={n.href} aria-current={n.match(path) ? "page" : undefined}><Icon name={n.icon} size={19} />{n.short}</Link>
        ))}
      </nav>
      <button type="button" className="icon-btn" aria-expanded={open} aria-controls="more-menu" aria-label="More pages and settings" onClick={() => setOpen((o) => !o)} style={moreActive ? { borderColor: "var(--accent-line)", color: "var(--accent-2)" } : undefined}>
        <Icon name="menu" />
      </button>
      {open && (
        <div className="menu" id="more-menu">
          {MOBILE_MORE.map((n) => <Link key={n.href} href={n.href} aria-current={n.match(path) ? "page" : undefined}><Icon name={n.icon} />{n.label}</Link>)}
          <div className="menu-sep" role="separator" />
          <ThemeToggle withLabel />
        </div>
      )}
    </div>
  );
}
