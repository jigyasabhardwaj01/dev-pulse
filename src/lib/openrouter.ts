import type { FetchLike, ModelCaller } from "./types";
import { sanitizeError } from "./text";

/*
 * The ONLY path by which JARVIS talks to an AI model. Every request goes to OpenRouter, to a model whose id starts with "google/",
 * and is pinned to Google's own endpoints (Google AI Studio and Google Vertex) with provider fallback DISABLED: if Google cannot
 * serve a request it fails, it is never silently sent to another vendor. Provider slugs and the model id were checked against
 * OpenRouter's /models and /models/{id}/endpoints on 2026-10-12 (see BACKEND.md section 18).
 */
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "google/gemini-3.7-flash";
/** OpenRouter provider slugs for Google. A base slug matches every region/variant of that provider. */
export const GOOGLE_PROVIDERS = ["google-ai-studio", "google-vertex"] as const;
export const MAX_ATTEMPTS = 3;

/** Only plain "google/<model>" ids: no routing variants (":nitro", ":floor", ":online"...), no other vendor, no odd characters. */
export const isGoogleModel = (m: unknown): m is string => typeof m === "string" && /^google\/[a-z0-9][a-z0-9.-]*$/.test(m);

export interface CallStats { model: string; provider: string | null; latencyMs: number; promptTokens: number | null; completionTokens: number | null; costUsd: number | null; attempts: number }
export class AiError extends Error {
  /** fatal = retrying cannot help and the caller should stop (bad key, no credit, model/provider unavailable). */
  constructor(message: string, readonly code: "auth" | "credits" | "unavailable" | "bad_request" | "transient" | "malformed" | "routing" | "budget", readonly fatal: boolean) { super(message); this.name = "AiError"; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function providerPreferences() {
  return { order: [...GOOGLE_PROVIDERS], only: [...GOOGLE_PROVIDERS], allow_fallbacks: false, require_parameters: true };
}

export function buildRequest(model: string, prompt: string, json: boolean) {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    ...(json ? { response_format: { type: "json_object" } } : {}),
    provider: providerPreferences(),
    usage: { include: true },
  };
}

interface OrResponse {
  model?: string; provider?: string;
  choices?: { message?: { content?: unknown }; finish_reason?: string; error?: unknown }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number | string };
}

export function makeOpenRouterCaller(opts: {
  apiKey: string; model?: string; fetchImpl?: FetchLike; retryDelayMs?: number; referer?: string; onResult?: (s: CallStats) => void;
}): ModelCaller {
  const model = opts.model ?? DEFAULT_MODEL;
  if (!isGoogleModel(model)) throw new Error(`OPENROUTER_MODEL "${model}" is not a Google model id (must look like google/<model>)`);
  const doFetch = opts.fetchImpl ?? fetch;
  const delay = opts.retryDelayMs ?? 2000;
  let tripped: AiError | null = null; // once the key or credit is bad, every later call in this run fails at once instead of repeating it

  return async (prompt, o) => {
    if (tripped) throw tripped;
    const body = JSON.stringify(buildRequest(model, prompt, Boolean(o?.json)));
    let last: Error = new AiError("openrouter: no attempt made", "transient", false);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remaining = o?.deadline === undefined ? Infinity : o.deadline - Date.now();
      if (remaining < 1500) throw new AiError("openrouter: time budget exhausted", "budget", false);
      const t0 = Date.now();
      try {
        const res = await doFetch(`${OPENROUTER_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", "x-title": "JARVIS",
            ...(opts.referer ? { "http-referer": opts.referer } : {}),
          },
          body,
          signal: AbortSignal.timeout(Math.min(60_000, remaining)),
        });
        if (res.status === 401 || res.status === 403) throw (tripped = new AiError(`openrouter http ${res.status}: the API key was rejected`, "auth", true));
        if (res.status === 402) throw (tripped = new AiError("openrouter http 402: insufficient credits", "credits", true));
        if (res.status === 408 || res.status === 429 || res.status >= 500) {
          last = new AiError(`openrouter http ${res.status}`, "transient", false);
          const ra = Number(res.headers.get("retry-after"));
          if (attempt < MAX_ATTEMPTS) await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay * attempt, 15_000, Math.max(0, remaining - 1500)));
          continue;
        }
        if (res.status === 404) throw new AiError("openrouter http 404: no Google endpoint is available for this model (fallback to other vendors is disabled)", "unavailable", true);
        if (!res.ok) throw new AiError(`openrouter http ${res.status}: ${sanitizeError((await res.text().catch(() => "")).slice(0, 200))}`, "bad_request", true);

        const data = (await res.json().catch(() => null)) as OrResponse | null;
        if (!data || typeof data !== "object") throw new AiError("openrouter returned a body that is not JSON", "malformed", false);
        if (data.error) {
          const code = Number(data.error.code);
          if (code === 402) throw (tripped = new AiError("openrouter: insufficient credits", "credits", true));
          if (code === 401 || code === 403) throw (tripped = new AiError("openrouter: the API key was rejected", "auth", true));
          last = new AiError(`openrouter error ${sanitizeError(String(data.error.code ?? ""))}: ${sanitizeError(String(data.error.message ?? "").slice(0, 160))}`, "transient", false);
          if (attempt < MAX_ATTEMPTS && (code === 429 || code >= 500)) { await sleep(delay * attempt); continue; }
          throw last;
        }
        // Defence in depth: refuse an answer that did not come from a Google model on a Google provider, even though routing is restricted.
        if (data.model && !isGoogleModel(data.model.replace(/:.*$/, ""))) throw new AiError(`openrouter answered with a non-Google model "${sanitizeError(data.model).slice(0, 60)}"; discarded`, "routing", true);
        if (data.provider && !/google/i.test(data.provider)) throw new AiError(`openrouter routed to a non-Google provider "${sanitizeError(data.provider).slice(0, 60)}"; discarded`, "routing", true);
        const choice = data.choices?.[0];
        const content = choice?.message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : "")).join("") : "";
        if (!text.trim()) throw new AiError(`openrouter returned an empty response${choice?.finish_reason ? ` (finish: ${sanitizeError(choice.finish_reason).slice(0, 30)})` : ""}`, "malformed", false);
        opts.onResult?.({
          model: data.model ?? model, provider: data.provider ?? null, latencyMs: Date.now() - t0, attempts: attempt,
          promptTokens: data.usage?.prompt_tokens ?? null, completionTokens: data.usage?.completion_tokens ?? null, costUsd: typeof data.usage?.cost === "number" ? data.usage.cost : null,
        });
        return text;
      } catch (err) {
        if (err instanceof AiError && err.fatal) throw err;
        last = err as Error;
        if (attempt < MAX_ATTEMPTS) await sleep(Math.min(delay * attempt, Math.max(0, remaining - 1500)));
      }
    }
    throw last;
  };
}

export function openRouterFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): ModelCaller {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const model = env.OPENROUTER_MODEL || DEFAULT_MODEL;
  if (!isGoogleModel(model)) throw new Error(`OPENROUTER_MODEL "${model}" is not a Google model id; only google/<model> is allowed`);
  return makeOpenRouterCaller({ apiKey, model, fetchImpl, referer: env.APP_URL || undefined });
}

/** Does the live OpenRouter catalog list this model, and does it have a Google endpoint? Used by the smoke script, not on every run. */
export async function verifyModelInCatalog(model: string, fetchImpl: FetchLike = fetch): Promise<{ listed: boolean; googleProviders: string[] }> {
  const list = (await (await fetchImpl(`${OPENROUTER_BASE}/models`)).json()) as { data?: { id: string }[] };
  const listed = Boolean(list.data?.some((m) => m.id === model));
  if (!listed) return { listed, googleProviders: [] };
  const ep = (await (await fetchImpl(`${OPENROUTER_BASE}/models/${model}/endpoints`)).json()) as { data?: { endpoints?: { tag?: string }[] } };
  const tags = (ep.data?.endpoints ?? []).map((e) => String(e.tag ?? "").split("/")[0]);
  return { listed, googleProviders: [...new Set(tags.filter((t) => (GOOGLE_PROVIDERS as readonly string[]).includes(t)))] };
}
