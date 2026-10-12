import type { IconName } from "./Icons";

export interface NavItem { href: string; label: string; short: string; icon: IconName; blurb: string; match: (path: string) => boolean }

/** One list drives the sidebar, the mobile bar, the menu and the top-bar title, so they cannot disagree. */
export const NAV: NavItem[] = [
  { href: "/", label: "Overview", short: "Overview", icon: "overview", blurb: "Latest developer intelligence", match: (p) => p === "/" },
  { href: "/reports", label: "Weekly Reports", short: "Reports", icon: "reports", blurb: "One report per reporting week", match: (p) => p.startsWith("/reports") },
  { href: "/posts", label: "Evidence Explorer", short: "Evidence", icon: "evidence", blurb: "The posts behind each count", match: (p) => p.startsWith("/posts") },
  { href: "/history", label: "History", short: "History", icon: "history", blurb: "Week-over-week movement", match: (p) => p.startsWith("/history") },
  { href: "/watchlist", label: "Watchlist", short: "Watchlist", icon: "watch", blurb: "What JARVIS monitors and how strictly", match: (p) => p.startsWith("/watchlist") },
  { href: "/review", label: "Team Review", short: "Review", icon: "review", blurb: "Shortlist, vote and decide", match: (p) => p.startsWith("/review") || p.startsWith("/signin") },
  { href: "/pack", label: "Monday Pack", short: "Pack", icon: "pack", blurb: "Sprint pack from decided work", match: (p) => p.startsWith("/pack") },
  { href: "/status", label: "Pipeline Health", short: "Pipeline", icon: "pipeline", blurb: "Collection status, read-only", match: (p) => p.startsWith("/status") },
];
/** The three destinations kept in the compact mobile bar; the rest live in its menu. */
export const MOBILE_PRIMARY = NAV.slice(0, 3);
export const MOBILE_MORE = NAV.slice(3);

export const activeItem = (path: string): NavItem | undefined => NAV.find((n) => n.match(path));
