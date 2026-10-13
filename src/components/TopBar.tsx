"use client";

import { usePathname } from "next/navigation";
import LiveClock from "./LiveClock";
import { activeItem } from "./nav";
import ThemeToggle from "./ThemeToggle";

export default function TopBar() {
  const item = activeItem(usePathname());
  return (
    <div className="topbar">
      <div className="crumb">
        <strong>{item?.label ?? "JARVIS"}</strong>
        {item && <span>{item.blurb}</span>}
      </div>
      <div className="top-actions"><LiveClock /><ThemeToggle /></div>
    </div>
  );
}
