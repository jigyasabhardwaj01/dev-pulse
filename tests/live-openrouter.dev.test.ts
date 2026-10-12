import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { DEFAULT_MODEL, makeOpenRouterCaller, verifyModelInCatalog, type CallStats } from "@/lib/openrouter";

/** Developer tool, skipped unless LIVE_AI is set. Needs no key for the catalog check; the real call needs OPENROUTER_API_KEY. */
describe("live OpenRouter check (dev tool)", () => {
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  it.skipIf(!process.env.LIVE_AI)("the model is in the live catalog with a Google provider", async () => {
    const r = await verifyModelInCatalog(model);
    console.log(JSON.stringify({ model, ...r }));
    expect(r.listed).toBe(true);
    expect(r.googleProviders.length).toBeGreaterThan(0);
  });
  it.skipIf(!process.env.LIVE_AI || !process.env.OPENROUTER_API_KEY)("one short real request", async () => {
    let stats: CallStats | null = null;
    const call = makeOpenRouterCaller({ apiKey: process.env.OPENROUTER_API_KEY!, model, onResult: (s) => (stats = s) });
    const text = await call("Reply with exactly the single word: pong", { deadline: Date.now() + 60_000 });
    const out = { model, replyPreview: text.slice(0, 40), stats };
    console.log(JSON.stringify(out));
    if (process.env.LIVE_AI_OUT) writeFileSync(process.env.LIVE_AI_OUT, JSON.stringify(out, null, 2));
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
