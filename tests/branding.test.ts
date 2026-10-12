import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderBriefHtml, sendBriefEmail } from "@/lib/email";

vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/components/NavLinks", () => ({ default: () => null }));

describe("JARVIS branding", () => {
  it("the email heading, subject and sender name say JARVIS; the sender ADDRESS and idempotency key are unchanged", async () => {
    const html = renderBriefHtml("2026-10-02", "Intro.", [], null, null);
    expect(html).toContain("JARVIS · week of 2026-10-02");
    expect(html).not.toMatch(/Dev Pulse/i);
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{"id":"m"}', { status: 200 }));
    await sendBriefEmail({ weekStart: "2026-10-02", version: 1, narrative: "n", points: [] }, { RESEND_API_KEY: "k", DIGEST_TO_EMAIL: "a@b.c" } as unknown as NodeJS.ProcessEnv, f as never);
    const init = f.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.subject).toBe("JARVIS: developer pain points, week of 2026-10-02");
    expect(body.from).toBe("JARVIS <onboarding@resend.dev>");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("dev-pulse-brief-2026-10-02-v1"); // internal identifier, deliberately kept
  });
  it("page metadata uses JARVIS for the default and templated titles", async () => {
    const { metadata } = await import("@/app/layout");
    expect(metadata.title).toEqual({ default: "JARVIS", template: "%s · JARVIS" });
  });
  it("no user-facing source file still says Dev Pulse or Developer Community Pulse", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|css)$/.test(n) && /Dev Pulse|Developer Community Pulse|developer pulse/i.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk("src");
    expect(hits).toEqual([]);
  });
});
