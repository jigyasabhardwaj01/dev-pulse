import type { IconName } from "./Icons";

export interface NavItem { href: string; label: string; short: string; icon: IconName; blurb: string; match: (path: string) => boolean }

/** The whole product is three places. One list drives the sidebar, the mobile bar and the top-bar title, so they cannot disagree. */
export const NAV: NavItem[] = [
  { href: "/", label: "Insights", short: "Insights", icon: "overview", blurb: "What developers are struggling with this week", match: (p) => p === "/" },
  { href: "/explore", label: "Explore & Decide", short: "Explore", icon: "review", blurb: "Read the evidence and decide what deserves attention", match: (p) => p.startsWith("/explore") },
  { href: "/plan", label: "Weekly Action Plan", short: "Plan", icon: "pack", blurb: "What your team chose to look into", match: (p) => p.startsWith("/plan") },
];

/** Reports, sources and diagnostics live here, out of the way. */
export const SETTINGS: NavItem = {
  href: "/settings", label: "Settings & Diagnostics", short: "Settings", icon: "settings", blurb: "Sources, past reports and technical status",
  match: (p) => ["/settings", "/status", "/reports", "/posts", "/history", "/watchlist"].some((x) => p === x || p.startsWith(`${x}/`)),
};

export const MOBILE_PRIMARY = NAV;
export const MOBILE_MORE = [SETTINGS];

export const activeItem = (path: string): NavItem | undefined => [...NAV, SETTINGS].find((n) => n.match(path));
