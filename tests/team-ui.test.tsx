import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({ session: null as unknown, watch: vi.fn() }));
vi.mock("@/lib/session", () => ({ currentSession: async () => mocks.session }));
vi.mock("@/lib/team-data", async (orig) => ({ ...(await orig<typeof import("@/lib/team-data")>()), loadWatchlist: mocks.watch }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/" }));

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const term = (o: object) => ({ id: "w1", topic_id: "t1", term: "code review", kind: "include", status: "active", applies_to: null, matches: 5, activity: "producing", scopeLabel: null, ...o });
const watchView = (): any => ({
  sensitivity: "balanced",
  topics: [{ id: "t1", name: "Code review", legacy: false, legacyKeywords: [], includes: [term({}), term({ id: "w2", term: "build", activity: "none", matches: 0 }), term({ id: "w3", term: "pr queue", status: "paused", activity: "paused" })], excludes: [term({ id: "x1", term: "meme", kind: "exclude", applies_to: "w1", scopeLabel: "code review", matches: 2 })] }],
  changes: [{ id: 1, at: "2026-10-12T05:00:00Z", actor: "owner@team.test", action: "add", subject: "include:build", before: null, after: null }],
});

describe("Watchlist page", async () => {
  const { default: Watchlist } = await import("@/app/watchlist/page");
  beforeEach(() => { mocks.watch.mockResolvedValue(watchView()); });
  const page = async () => html(await Watchlist());

  it("everyone gets the controls: add, pause/resume, remove and the three modes, each with an accessible name; no sign-in anywhere", async () => {
    mocks.session = { email: "visitor", role: "owner" };
    const out = await page();
    expect(out).toContain("Add a term to Code review");
    expect(out).toMatch(/Pause<span class="sr-only"> “code review”/);
    expect(out).toMatch(/Resume<span class="sr-only"> “pr queue”/);
    expect(out).toContain("Strict"); expect(out).toContain("Balanced"); expect(out).toContain("Early discovery");
    expect(out.match(/type="radio"/g)).toHaveLength(3);
    expect(out).toContain("applies from the next run");
    expect(out).toContain("Producing evidence"); expect(out).toContain("Ambiguous"); expect(out).toContain("only for “code review”");
    expect(out).not.toMatch(/Sign in|sign-in|signin/i);
  });
  it("a database failure is an honest error, not an empty watchlist", async () => {
    mocks.session = { email: "visitor", role: "owner" }; mocks.watch.mockRejectedValue(new Error("down"));
    const out = await page();
    expect(out).toContain("couldn&#x27;t load the watchlist");
    expect(out).not.toContain("Watching for");
  });
  it("a topic still on legacy keywords says so", async () => {
    mocks.session = { email: "visitor", role: "owner" };
    const v = watchView(); v.topics[0] = { ...v.topics[0], legacy: true, legacyKeywords: ["ci slow"], includes: [], excludes: [] };
    mocks.watch.mockResolvedValue(v);
    expect(await page()).toContain("built-in keywords are used: ci slow");
  });
});
