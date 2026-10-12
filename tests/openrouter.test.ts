import { describe, expect, it, vi } from "vitest";
import { AiError, DEFAULT_MODEL, GOOGLE_PROVIDERS, MAX_ATTEMPTS, buildRequest, isGoogleModel, makeOpenRouterCaller, openRouterFromEnv, providerPreferences, verifyModelInCatalog } from "@/lib/openrouter";

const ok = (text: string, extra: object = {}) => new Response(JSON.stringify({ model: "google/gemini-3.7-flash", provider: "Google AI Studio", choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.00002 }, ...extra }), { status: 200 });
const caller = (f: unknown, over: object = {}) => makeOpenRouterCaller({ apiKey: "sk-or-secret", fetchImpl: f as never, retryDelayMs: 1, ...over });

describe("request construction", () => {
  it("posts to the OpenRouter chat endpoint with a Bearer key, a Google model and Google-only routing with fallbacks off", async () => {
    const f = vi.fn().mockResolvedValue(ok("hi"));
    expect(await caller(f, { referer: "https://app.test" })("PROMPT", { json: true })).toBe("hi");
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer sk-or-secret", "content-type": "application/json", "http-referer": "https://app.test" });
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("google/gemini-3.7-flash");
    expect(body.messages).toEqual([{ role: "user", content: "PROMPT" }]);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.provider).toEqual({ order: ["google-ai-studio", "google-vertex"], only: ["google-ai-studio", "google-vertex"], allow_fallbacks: false, require_parameters: true });
    expect(body.usage).toEqual({ include: true });
  });
  it("only asks for JSON mode when the caller needs JSON", () => {
    expect(buildRequest("google/x", "p", false)).not.toHaveProperty("response_format");
    expect(providerPreferences().only).toEqual([...GOOGLE_PROVIDERS]);
  });
  it("the default is the verified google/gemini-3.7-flash", () => expect(DEFAULT_MODEL).toBe("google/gemini-3.7-flash"));
  it("accepts only plain google/ ids: no other vendor, no routing variants, no junk", () => {
    for (const m of ["google/gemini-3.7-flash", "google/gemini-2.5-flash-lite", "google/gemma-3-27b-it"]) expect(isGoogleModel(m)).toBe(true);
    for (const m of ["openai/gpt-5", "anthropic/claude-opus-5-5", "gemini-3.7-flash", "google/gemini-3.7-flash:nitro", "google/gemini:floor", "google/", "Google/x", "google/x y", "google/../openai/gpt", "", undefined, null, 5]) expect(isGoogleModel(m as never)).toBe(false);
    expect(() => makeOpenRouterCaller({ apiKey: "k", model: "openai/gpt-5" })).toThrow(/not a Google model/);
  });
});

describe("environment", () => {
  const env = (o: object) => o as NodeJS.ProcessEnv;
  it("needs the key; the model defaults to the verified Google id; any non-Google model is refused", () => {
    expect(() => openRouterFromEnv(env({}))).toThrow(/OPENROUTER_API_KEY is not set/);
    expect(() => openRouterFromEnv(env({ OPENROUTER_API_KEY: "k" }))).not.toThrow();
    expect(() => openRouterFromEnv(env({ OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "google/gemini-3.8-flash" }))).not.toThrow();
    expect(() => openRouterFromEnv(env({ OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "openai/gpt-5" }))).toThrow(/only google\//);
    expect(() => openRouterFromEnv(env({ OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "google/gemini-3.7-flash:nitro" }))).toThrow(/only google\//);
  });
  it("the old GEMINI_ variables are not read: an app with only those has no AI", () => {
    expect(() => openRouterFromEnv(env({ GEMINI_API_KEY: "g", GEMINI_MODEL: "gemini-3.8-flash" }))).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("retries and failures", () => {
  it("retries 429 and 5xx a bounded number of times, then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(ok("done"));
    expect(await caller(f)("p")).toBe("done");
    expect(f).toHaveBeenCalledTimes(3);
  });
  it(`gives up after ${MAX_ATTEMPTS} attempts on persistent rate limiting`, async () => {
    const f = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    await expect(caller(f)("p")).rejects.toThrow("429");
    expect(f).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });
  it("retries a network failure and a body-level 429, bounded", async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 429, message: "slow down" } }), { status: 200 })).mockResolvedValueOnce(ok("fine"));
    expect(await caller(f)("p")).toBe("fine");
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("402 insufficient credit stops at once, and the caller then refuses further calls without touching the network", async () => {
    const f = vi.fn().mockResolvedValue(new Response("{}", { status: 402 }));
    const c = caller(f);
    await expect(c("p")).rejects.toMatchObject({ code: "credits", fatal: true });
    await expect(c("again")).rejects.toMatchObject({ code: "credits" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("401 and 403 are permanent: no retry, key never echoed", async () => {
    for (const status of [401, 403]) {
      const f = vi.fn().mockResolvedValue(new Response("bad key sk-or-secret", { status }));
      const e = (await caller(f)("p").catch((x) => x)) as AiError;
      expect(e).toMatchObject({ code: "auth", fatal: true });
      expect(String(e.message)).not.toContain("sk-or-secret");
      expect(f).toHaveBeenCalledTimes(1);
    }
  });
  it("a 404 (no Google endpoint) and other 4xx fail fast and do NOT fall back to another vendor", async () => {
    const f = vi.fn().mockResolvedValue(new Response("no endpoints", { status: 404 }));
    await expect(caller(f)("p")).rejects.toMatchObject({ code: "unavailable", fatal: true });
    expect(f).toHaveBeenCalledTimes(1);
    const g = vi.fn().mockResolvedValue(new Response("nope", { status: 400 }));
    await expect(caller(g)("p")).rejects.toMatchObject({ code: "bad_request" });
    expect(g).toHaveBeenCalledTimes(1);
  });
  it("body-level 402 and 401 errors trip the breaker too", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 402, message: "credits" } }), { status: 200 }));
    await expect(caller(f)("p")).rejects.toMatchObject({ code: "credits" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("honours the deadline: no request when the budget is spent, and no sleeping past it", async () => {
    const f = vi.fn();
    await expect(caller(f)("p", { deadline: Date.now() - 1 })).rejects.toThrow(/time budget/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("malformed and misrouted responses", () => {
  it("rejects non-JSON, empty content, missing choices, and reports them as retryable-then-failed", async () => {
    for (const res of [() => new Response("<html>", { status: 200 }), () => ok(""), () => new Response(JSON.stringify({ choices: [] }), { status: 200 }), () => new Response(JSON.stringify({ choices: [{ message: { content: null } }] }), { status: 200 })]) {
      const f = vi.fn().mockImplementation(async () => res());
      await expect(caller(f)("p")).rejects.toBeInstanceOf(Error);
      expect(f.mock.calls.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
    }
  });
  it("joins content parts when the model returns an array", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: "google/gemini-3.7-flash", choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] }), { status: 200 }));
    expect(await caller(f)("p")).toBe("ab");
  });
  it("discards an answer from a non-Google model or provider even if routing was somehow ignored", async () => {
    const m = vi.fn().mockResolvedValue(ok("x", { model: "openai/gpt-5" }));
    await expect(caller(m)("p")).rejects.toMatchObject({ code: "routing", fatal: true });
    const p = vi.fn().mockResolvedValue(ok("x", { provider: "SomeOtherCloud" }));
    await expect(caller(p)("p")).rejects.toMatchObject({ code: "routing", fatal: true });
    expect(m).toHaveBeenCalledTimes(1);
  });
  it("accepts either Google provider name and a variant model suffix returned by the API", async () => {
    for (const provider of ["Google", "Google AI Studio", "Google Vertex"]) {
      expect(await caller(vi.fn().mockResolvedValue(ok("y", { provider, model: "google/gemini-3.7-flash:batch" })))("p")).toBe("y");
    }
  });
});

describe("usage reporting", () => {
  it("reports model, provider, latency, tokens and cost for each successful call", async () => {
    const seen: unknown[] = [];
    await caller(vi.fn().mockResolvedValue(ok("hi")), { onResult: (s: unknown) => seen.push(s) })("p");
    expect(seen).toEqual([expect.objectContaining({ model: "google/gemini-3.7-flash", provider: "Google AI Studio", promptTokens: 12, completionTokens: 3, costUsd: 0.00002, attempts: 1 })]);
  });
  it("reports nulls, not zeros, when the API gives no usage", async () => {
    const seen: { costUsd: unknown; promptTokens: unknown }[] = [];
    await caller(vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "z" } }] }))), { onResult: (s: never) => seen.push(s) })("p");
    expect(seen[0]).toMatchObject({ costUsd: null, promptTokens: null });
  });
});

describe("catalog verification", () => {
  const catalog = (ids: string[], tags: string[]) => vi.fn(async (u: string) => new Response(JSON.stringify(u.endsWith("/endpoints") ? { data: { endpoints: tags.map((tag) => ({ tag })) } } : { data: ids.map((id) => ({ id })) })));
  it("confirms a listed model and its Google providers (tier/region suffixes folded into the base slug)", async () => {
    const r = await verifyModelInCatalog("google/gemini-3.7-flash", catalog(["google/gemini-3.7-flash"], ["google-vertex/global", "google-ai-studio", "google-ai-studio/flex", "other/x"]) as never);
    expect(r).toEqual({ listed: true, googleProviders: ["google-vertex", "google-ai-studio"] });
  });
  it("reports an unlisted model as not listed", async () => {
    expect(await verifyModelInCatalog("google/nope", catalog(["google/a"], []) as never)).toEqual({ listed: false, googleProviders: [] });
  });
});
