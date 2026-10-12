import { describe, expect, it, vi } from "vitest";
import { runDigest, type Deps } from "@/lib/pipeline";
import { EMAIL_KEY_SAFE_MS, EMAIL_LEASE_MS } from "@/lib/store";
import { EmailSendError, sendBriefEmail } from "@/lib/email";
import { NOT_COMPARED_SENTENCE, FIRST_WEEK_SENTENCE } from "@/lib/brief";
import { MemoryStore, post } from "./helpers";

const NOW = new Date("2026-10-09T03:30:00Z");
const WEEK = "2026-10-02";
const classifier = () => async (prompt: string) => {
  if (prompt.includes("intro line")) {
    if (prompt.includes(FIRST_WEEK_SENTENCE)) return `${FIRST_WEEK_SENTENCE} Slow reviews led the week.`;
    if (prompt.includes(NOT_COMPARED_SENTENCE)) return `${NOT_COMPARED_SENTENCE} Slow reviews led the week.`;
    return "Slow reviews led the week. Nothing else stands out.";
  }
  const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
  return JSON.stringify(Array.from({ length: n }, (_, index) => ({ index, theme: "False positives", sentiment: "negative", unresolved: true })));
};
const hnPosts = (...ids: string[]) => async () => ids.map((id) => post({ source_id: id }));

const sleeps: number[] = [];
const base = (store: MemoryStore, over: Partial<Deps> = {}): Deps => ({
  store, now: NOW, callModel: classifier(), fetchers: { hn: hnPosts("a") }, sleep: async (ms) => { sleeps.push(ms); }, ...over,
});
const ok = () => vi.fn(async () => ({ status: "sent" as const, messageId: "msg_1" }));
const ambiguous = () => new EmailSendError("resend http 503: down", false);
const definite = () => new EmailSendError("resend http 422: bad", true);

describe("recording a successful delivery is retried", () => {
  it("a transient database failure is retried and the week ends up 'sent'", async () => {
    sleeps.length = 0;
    const store = new MemoryStore();
    store.failTimes.markEmailSent = 2;
    const send = ok();
    const s = await runDigest(base(store, { sendEmail: send }));
    expect(s.email).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1); // the email was sent once, only the record was retried
    expect(store.emails.get(WEEK)?.status).toBe("sent");
    expect(sleeps).toEqual([500, 1500]);
    expect(s.warnings.join()).not.toMatch(/could not be recorded/);
  });
  it("if it never succeeds the claim stays 'sending' (not failed) and a warning is raised", async () => {
    const store = new MemoryStore();
    store.fail.markEmailSent = new Error("db down");
    const send = ok();
    const s = await runDigest(base(store, { sendEmail: send }));
    expect(s.warnings.join()).toMatch(/could not be recorded as sent after 3 attempts/);
    expect(store.emails.get(WEEK)?.status).toBe("sending");
  });
});

describe("a failed record can never trigger a resend after the provider's key expires", () => {
  const stuck = async (ageMs: number) => {
    const store = new MemoryStore();
    store.fail.markEmailSent = new Error("db down");
    await runDigest(base(store, { sendEmail: ok() }));
    store.fail = {};
    store.emails.set(WEEK, { status: "sending", claimedAt: Date.now() - ageMs });
    const send = ok();
    const s = await runDigest(base(store, { sendEmail: send }));
    return { s, send, store };
  };
  it("within the key window, after the lease: retaken and resent with the same key", async () => {
    const { s, send } = await stuck(EMAIL_LEASE_MS + 1000);
    expect(s.email).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("before the lease ends: left alone", async () => {
    const { s, send } = await stuck(60_000);
    expect(s.email).toBe("in_progress");
    expect(send).not.toHaveBeenCalled();
  });
  it("past the key window: fails closed, no send, reported unconfirmed, run marked partial", async () => {
    const { s, send, store } = await stuck(EMAIL_KEY_SAFE_MS + 60_000);
    expect(send).not.toHaveBeenCalled();
    expect(s.email).toBe("unconfirmed");
    expect(s.status).toBe("partial");
    expect(s.warnings.join()).toMatch(/unconfirmed/);
    expect(store.emails.get(WEEK)?.status).toBe("sending"); // untouched: nothing was decided for the person
  });
  it("a 'sending' claim with no timestamp is also unconfirmed, never retaken", async () => {
    const store = new MemoryStore();
    await runDigest(base(store));
    store.emails.set(WEEK, { status: "sending", claimedAt: null });
    const send = ok();
    expect((await runDigest(base(store, { sendEmail: send }))).email).toBe("unconfirmed");
    expect(send).not.toHaveBeenCalled();
  });
  it("a sent week is never sent again whatever its age", async () => {
    const store = new MemoryStore();
    await runDigest(base(store, { sendEmail: ok() }));
    store.emails.set(WEEK, { ...store.emails.get(WEEK)!, claimedAt: Date.now() - 10 * EMAIL_KEY_SAFE_MS });
    const send = ok();
    expect((await runDigest(base(store, { sendEmail: send }))).email).toBe("already_sent");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("a send whose outcome is unknown", () => {
  it("is retried with backoff, then succeeds", async () => {
    sleeps.length = 0;
    const store = new MemoryStore();
    const send = vi.fn().mockRejectedValueOnce(ambiguous()).mockResolvedValueOnce({ status: "sent", messageId: "m" });
    const s = await runDigest(base(store, { sendEmail: send }));
    expect(s.email).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
  });
  it("after the last retry stays 'sending' (not failed): the message may have been accepted", async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockRejectedValue(ambiguous());
    const s = await runDigest(base(store, { sendEmail: send }));
    expect(send).toHaveBeenCalledTimes(3);
    expect(s.email).toBe("unconfirmed");
    expect(store.emails.get(WEEK)?.status).toBe("sending");
    // the next scheduled run is a week later: past the key window it must not resend
    store.emails.set(WEEK, { status: "sending", claimedAt: Date.now() - 7 * 86_400_000 });
    const again = ok();
    expect((await runDigest(base(store, { sendEmail: again }))).email).toBe("unconfirmed");
    expect(again).not.toHaveBeenCalled();
  });
  it("a definite rejection is marked failed (nothing was sent) and is retried by the next run", async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockRejectedValue(definite());
    expect((await runDigest(base(store, { sendEmail: send }))).email).toBe("failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.emails.get(WEEK)?.status).toBe("failed");
    expect((await runDigest(base(store, { sendEmail: ok() }))).email).toBe("sent");
  });
});

describe("provider error classification (sendBriefEmail)", () => {
  const env = { RESEND_API_KEY: "k", DIGEST_TO_EMAIL: "a@b.c" } as unknown as NodeJS.ProcessEnv;
  const args = { weekStart: "2026-10-02", version: 1, narrative: "n", points: [] };
  const respond = (status: number) => vi.fn(async (_url?: string, _init?: RequestInit) => new Response(status === 200 ? '{"id":"m1"}' : "{}", { status }));
  const kind = async (f: ReturnType<typeof respond>) => { try { await sendBriefEmail(args, env, f as never); return "sent"; } catch (e) { return e instanceof EmailSendError ? (e.definite ? "definite" : "ambiguous") : "other"; } };
  it.each([[422, "definite"], [429, "definite"], [401, "definite"], [409, "ambiguous"], [500, "ambiguous"], [503, "ambiguous"], [200, "sent"]])("HTTP %i is %s", async (status, expected) => {
    expect(await kind(respond(status))).toBe(expected);
  });
  it("a network failure or timeout is ambiguous", async () => {
    expect(await kind(vi.fn(async () => { throw new TypeError("fetch failed"); }) as never)).toBe("ambiguous");
  });
  it("sends the version-scoped idempotency key and a request timeout", async () => {
    const f = respond(200);
    await sendBriefEmail(args, env, f as never);
    const init = f.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("dev-pulse-brief-2026-10-02-v1");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
