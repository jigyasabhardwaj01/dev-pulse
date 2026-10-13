import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ProblemTile, { TILE_KINDS, tileKind } from "@/components/motion/ProblemTile";
import Wordmark from "@/components/motion/Wordmark";
import Equation from "@/components/motion/Equation";
import CutLine from "@/components/motion/CutLine";
import WeekScrubber from "@/components/motion/WeekScrubber";
import Count from "@/components/motion/Count";
import EmptyState from "@/components/EmptyState";
import { THEME_BOOT } from "@/components/ThemeToggle";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/" }));
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("decorative motion pieces stay out of the way of assistive tech", () => {
  it("the wordmark, tiles, cut line and empty-state art are hidden from screen readers", () => {
    expect(html(<Wordmark />)).toMatch(/^<div class="wordmark " aria-hidden="true">/);
    expect(html(<ProblemTile label="Slow reviews" />)).toContain('aria-hidden="true"');
    expect(html(<CutLine />)).toContain('aria-hidden="true"');
    expect(html(<EmptyState title="Nothing" body="b" />)).toMatch(/<pre class="empty-art" aria-hidden="true">/);
  });
  it("the equation strip has one plain-language label and its scrolling copy is hidden", () => {
    const o = html(<Equation />);
    expect(o).toContain('role="img"'); expect(o).toMatch(/aria-label="How JARVIS works: Hacker News, Stack Overflow and GitHub/);
    expect(o).toContain('class="equation-track" aria-hidden="true"');
  });
  it("a problem keeps the same tile look every week, and every kind renders", () => {
    expect(tileKind("Slow reviews")).toBe(tileKind("Slow reviews"));
    for (const k of TILE_KINDS) expect(html(<ProblemTile label="Flaky tests" kind={k} />)).toContain(`tile-${k}`);
  });
  it("numbers render their real value on the server (correct without JavaScript)", () => {
    expect(html(<Count n={29} />)).toBe("29");
  });
  it("the saved theme is applied before paint, light by default", () => {
    expect(THEME_BOOT).toContain('"dark"');
    expect(THEME_BOOT).not.toContain('"light"');
  });
});

describe("the week scrubber", () => {
  const items = [
    { key: "a", theme: "Slow reviews", href: "/explore/problem?a", firstSeen: "2026-10-02T00:00:00Z", lastSeen: "2026-10-03T00:00:00Z", discussions: 5 },
    { key: "b", theme: "Flaky tests", href: "/explore/problem?b", firstSeen: "2026-10-06T00:00:00Z", lastSeen: "2026-10-07T00:00:00Z", discussions: 4 },
  ];
  const o = html(<WeekScrubber periodStart="2026-10-01T18:30:00.000Z" periodLabel="Fri 2 Oct – Thu 8 Oct 2026 (IST)" items={items} />);
  it("is an accessible, keyboard-operable slider over the seven reporting days", () => {
    expect(o).toContain('role="slider"'); expect(o).toContain('tabindex="0"'); expect(o).toContain('aria-valuemin="1"'); expect(o).toContain('aria-valuemax="7"');
    for (const d of ["Fri", "Sat", "Sun", "Mon", "Tue", "Wed", "Thu"]) expect(o).toContain(`>${d}<`);
    expect(o).toContain('aria-label="Pause the week replay"');
  });
  it("lights only the problems discussed on the shown day (day 1 here), and every tile opens its evidence", () => {
    expect(o).toContain("1 of 2 problems discussed that day");
    expect(o).toMatch(/class="scrub-tile on"[^>]*aria-label="Slow reviews: 5 discussions/);
    expect(o).toContain('href="/explore/problem?a"'); expect(o).toContain('href="/explore/problem?b"');
  });
});
