import { describe, expect, it, vi } from "vitest";
import { EmailSendError, sendBriefEmail, sendRehearsalEmail } from "@/lib/email";
import { buildFridayBrief } from "@/lib/friday-brief";
import { analyse, type EvidencePost } from "@/lib/analysis";

let n = 0;
const ev = (o: Partial<EvidencePost> = {}): EvidencePost => ({ id: `p${++n}`, source: "hn", topic_id: "t1", theme: "Slow reviews", title: `Distinct discussion title number ${n}`, url: `https://x.test/${n}`, author: `a${n}`, posted_at: "2026-10-03T10:00:00Z", confidence: 0.8, excerpt: "waits days", resolution: "open", unresolved: true, flags: [], ...o });
const COV = { hn: { status: "ok" as const, posts: 1 }, stackoverflow: { status: "ok" as const, posts: 1 }, reddit: { status: "ok" as const, posts: 1 }, github: { status: "ok" as const, posts: 1 } };
const brief = (posts: EvidencePost[] = [ev(), ev(), ev()], narrative = "A summary.") =>
  buildFridayBrief({ weekStart: "2026-10-02", periodLabel: "Fri 2 Oct – Thu 8 Oct 2026 (IST)", analysis: analyse({ weekStart: "2026-10-02", posts, trends: [], topicNames: { t1: "Code review" }, coverage: COV, comparison: "no_prior", prior: [] }), narrative, usedFallback: false });
const env = { RESEND_API_KEY: "re_test_key", DIGEST_TO_EMAIL: "me@team.test", APP_URL: "https://app.test" } as unknown as NodeJS.ProcessEnv;
const ok = () => vi.fn(async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
const sent = (f: ReturnType<typeof ok>) => { const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]; return { url, h: init.headers as Record<string, string>, body: JSON.parse(init.body as string) }; };

describe("rehearsal email", () => {
  it("is labelled in the subject and in the body, and goes only to the configured recipient", async () => {
    const f = ok();
    expect(await sendRehearsalEmail({ brief: brief(), nonce: "n1" }, env, f as never)).toEqual({ status: "sent", messageId: "msg_1" });
    const { url, h, body } = sent(f);
    expect(url).toBe("https://api.resend.com/emails");
    expect(body.to).toEqual(["me@team.test"]);
    expect(body.subject).toBe("[Rehearsal] JARVIS: developer pain points, week of 2026-10-02");
    expect(body.html).toContain("Rehearsal."); expect(body.html).toContain("not changed");
    expect(body.from).toBe("JARVIS <onboarding@resend.dev>");
    expect(h.authorization).toBe("Bearer re_test_key");
  });
  it("never uses the real send's idempotency key, so it cannot block or imitate the Friday email", async () => {
    const a = ok(), b = ok(), real = ok();
    await sendRehearsalEmail({ brief: brief(), nonce: "n1" }, env, a as never);
    await sendRehearsalEmail({ brief: brief(), nonce: "n2" }, env, b as never);
    await sendBriefEmail({ weekStart: "2026-10-02", version: 1, narrative: "x", points: [] }, env, real as never);
    const keys = [sent(a).h["idempotency-key"], sent(b).h["idempotency-key"]];
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys.every((k) => k.startsWith("jarvis-rehearsal-"))).toBe(true);
    expect(sent(real).h["idempotency-key"]).toBe("dev-pulse-brief-2026-10-02-v1");
    expect(keys).not.toContain(sent(real).h["idempotency-key"]);
  });
  it("is skipped, with no request at all, when the key or recipient is missing or empty", async () => {
    for (const e of [{}, { RESEND_API_KEY: "k" }, { DIGEST_TO_EMAIL: "a@b.c" }, { RESEND_API_KEY: "", DIGEST_TO_EMAIL: "a@b.c" }] as unknown as NodeJS.ProcessEnv[]) {
      const f = ok();
      expect(await sendRehearsalEmail({ brief: brief(), nonce: "n" }, e, f as never)).toBe("skipped");
      expect(f).not.toHaveBeenCalled();
    }
  });
  it("a 4xx rejection is definite, a 5xx / 409 / network failure is ambiguous, and the key never leaks into the error", async () => {
    const run = async (r: () => Promise<Response>) => sendRehearsalEmail({ brief: brief(), nonce: "n" }, env, vi.fn(r) as never).catch((e) => e as EmailSendError);
    const bad = await run(async () => new Response("invalid to address", { status: 422 }));
    expect(bad).toBeInstanceOf(EmailSendError); expect((bad as EmailSendError).definite).toBe(true); expect((bad as Error).message).not.toContain("re_test_key");
    expect(((await run(async () => new Response("x", { status: 503 }))) as EmailSendError).definite).toBe(false);
    expect(((await run(async () => new Response("x", { status: 409 }))) as EmailSendError).definite).toBe(false);
    expect(((await run(async () => { throw new TypeError("network"); })) as EmailSendError).definite).toBe(false);
  });
  it("still reports sent when the success body is not JSON", async () => {
    const r = await sendRehearsalEmail({ brief: brief(), nonce: "n" }, env, vi.fn(async () => new Response("ok", { status: 200 })) as never);
    expect(r).toEqual({ status: "sent", messageId: null });
  });
});

describe("rehearsal email content edge cases", () => {
  const html = async (b = brief(), e: NodeJS.ProcessEnv = env) => { const f = ok(); await sendRehearsalEmail({ brief: b, nonce: "n" }, e, f as never); return sent(f).body.html as string; };
  it("escapes hostile text from discussions and the summary", async () => {
    const out = await html(brief([ev({ theme: "<img src=x onerror=1>", title: "<script>x</script>" }), ev({ theme: "<img src=x onerror=1>" }), ev({ theme: "<img src=x onerror=1>" })], "<b onclick=1>hi</b>"));
    expect(out).not.toContain("<img src=x"); expect(out).not.toContain("<script>x"); expect(out).not.toContain("<b onclick");
  });
  it("only links http(s) evidence, never javascript: urls", async () => {
    const out = await html(brief([ev({ url: "javascript:alert(1)" }), ev({ url: "https://ok.test/1" }), ev({ url: "data:text/html,x" })]));
    expect(out).not.toContain("javascript:"); expect(out).not.toContain("data:text"); expect(out).toContain("https://ok.test/1");
  });
  it("an empty week says so and ranks nothing, and a nothing-ranked week does not claim problems", async () => {
    const empty = await html(brief([]));
    expect(empty).toContain("No pain point has enough supporting evidence to be ranked");
    const weak = await html(brief([ev({ excerpt: null }), ev({ excerpt: null })]));
    expect(weak).toContain("No pain point has enough supporting evidence to be ranked");
  });
  it("shows the template note when the summary was not AI-written", async () => {
    const b = buildFridayBrief({ weekStart: "2026-10-02", periodLabel: "p", analysis: analyse({ weekStart: "2026-10-02", posts: [], trends: [], topicNames: {}, coverage: COV, comparison: "no_prior", prior: [] }), narrative: "T", usedFallback: true });
    expect(await html(b)).toContain("template text, AI summary unavailable");
  });
  it("omits the dashboard link when no app url is configured, instead of printing a broken one", async () => {
    const out = await html(brief(), { RESEND_API_KEY: "k", DIGEST_TO_EMAIL: "me@team.test" } as unknown as NodeJS.ProcessEnv);
    expect(out).not.toContain("undefined"); expect(out).not.toContain("null");
  });
  it("a long summary and a thousand-post week render without error", async () => {
    const out = await html(brief(Array.from({ length: 1000 }, () => ev()), "word ".repeat(5000)));
    expect(out.length).toBeGreaterThan(1000);
  });
});
