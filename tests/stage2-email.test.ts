import { describe, expect, it, vi } from "vitest";
import { renderBriefHtml, sendBriefEmail } from "@/lib/email";
import { buildTrends } from "@/lib/trend";
import type { Comparison } from "@/lib/coverage";

const points = buildTrends([{ topic_id: "t", theme: "Slow reviews", count: 3, unresolved: 2 }], [], { t: "Code review" });
const ENV = { RESEND_API_KEY: "re_test_key_123", DIGEST_TO_EMAIL: "sumit@example.com", APP_URL: "https://dev.example" } as unknown as NodeJS.ProcessEnv;
const okRes = () => new Response(JSON.stringify({ id: "msg_abc" }), { status: 200 });
const capture = () => {
  const f = vi.fn(async (_u: string, _i?: RequestInit) => okRes());
  const init = () => f.mock.calls[0][1] as RequestInit & { headers: Record<string, string>; body: string };
  return { f, init };
};
const args = { weekStart: "2026-10-02", version: 3, narrative: "Intro one. Intro two.", points, comparison: { state: "comparable", reasons: [] } as Comparison };

describe("sendBriefEmail: the actual Resend request", () => {
  it("posts to Resend with the bearer key, the unchanged sender, and the configured recipient", async () => {
    const { f, init } = capture();
    const r = await sendBriefEmail(args, ENV, f);
    expect(f.mock.calls[0][0]).toBe("https://api.resend.com/emails");
    expect(init().method).toBe("POST");
    expect(init().headers.authorization).toBe("Bearer re_test_key_123");
    const body = JSON.parse(init().body);
    expect(body.from).toBe("JARVIS <onboarding@resend.dev>");
    expect(body.to).toEqual(["sumit@example.com"]);
    expect(body.subject).toContain("2026-10-02");
    expect(r).toEqual({ status: "sent", messageId: "msg_abc" });
  });
  it("scopes the idempotency key to the report version, and the key never changes for the same version", async () => {
    const a = capture(); await sendBriefEmail(args, ENV, a.f);
    const b = capture(); await sendBriefEmail(args, ENV, b.f);
    const c = capture(); await sendBriefEmail({ ...args, version: 4 }, ENV, c.f);
    expect(a.init().headers["idempotency-key"]).toBe("dev-pulse-brief-2026-10-02-v3");
    expect(b.init().headers["idempotency-key"]).toBe(a.init().headers["idempotency-key"]);
    expect(c.init().headers["idempotency-key"]).toBe("dev-pulse-brief-2026-10-02-v4");
  });
  it("sends a byte-identical body for the same version (so a provider can de-duplicate a resend)", async () => {
    const a = capture(); await sendBriefEmail(args, ENV, a.f);
    const b = capture(); await sendBriefEmail(args, ENV, b.f);
    expect(a.init().body).toBe(b.init().body);
  });
  it("is skipped, without any request, when the key or recipient is missing", async () => {
    const f = vi.fn();
    expect(await sendBriefEmail(args, { ...ENV, RESEND_API_KEY: "" }, f)).toBe("skipped");
    expect(await sendBriefEmail(args, { ...ENV, DIGEST_TO_EMAIL: "" }, f)).toBe("skipped");
    expect(f).not.toHaveBeenCalled();
  });
  it("throws on a non-2xx response without leaking the API key", async () => {
    const f = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const err = await sendBriefEmail(args, ENV, f).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/429/);
    expect((err as Error).message).not.toContain("re_test_key_123");
  });
  it("still reports sent when the success body cannot be parsed", async () => {
    expect(await sendBriefEmail(args, ENV, async () => new Response("not json", { status: 200 }))).toEqual({ status: "sent", messageId: null });
  });
});

describe("email body", () => {
  it("shows the IST period, consistent totals, and a dashboard link", () => {
    const html = renderBriefHtml("2026-10-02", "A b. C d.", points, "https://dev.example", { state: "comparable", reasons: [] });
    expect(html).toContain("Fri 2 Oct – Thu 8 Oct 2026 (IST)");
    expect(html).toContain("3 mentions matched to tracked themes across 1 pain points");
    expect(html).toContain('href="https://dev.example"');
  });
  it("counts only pain points that have mentions, so dropped-to-zero themes do not inflate the headline", () => {
    const withDropped = buildTrends(
      [{ topic_id: "t", theme: "A", count: 2, unresolved: 0 }],
      [{ topic_id: "t", theme: "A", count: 1, unresolved: 0 }, { topic_id: "t", theme: "Gone", count: 5, unresolved: 0 }],
      { t: "Code review" },
    );
    expect(withDropped.length).toBe(2);
    expect(renderBriefHtml("2026-10-02", "x y.", withDropped, null)).toContain("2 mentions matched to tracked themes across 1 pain points");
  });
  it("shows non-blocking caveats beside trends that are still asserted", () => {
    const html = renderBriefHtml("2026-10-02", "x y.", points, null, { state: "comparable", reasons: [], caveats: ["GitHub results hit the page limit this period, so its counts may be understated"] });
    expect(html).toContain("Caveats:");
    expect(html).toContain("GitHub results hit the page limit");
    expect(html).not.toContain("Data note:"); // comparable: nothing blocked
  });
});
