import type { FetchLike, ModelCaller } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeGeminiCaller(opts: {
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
  retryDelayMs?: number;
}): ModelCaller {
  const doFetch = opts.fetchImpl ?? fetch;
  const delay = opts.retryDelayMs ?? 2000;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`;

  return async (prompt, o) => {
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        ...(o?.json ? { responseMimeType: "application/json" } : {}),
      },
    });

    let lastErr: Error = new Error("gemini: no attempt made");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
          body,
          signal: AbortSignal.timeout(45_000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`gemini http ${res.status}`);
        } else if (!res.ok) {
          throw Object.assign(new Error(`gemini http ${res.status}: ${(await res.text()).slice(0, 200)}`), { fatal: true });
        } else {
          const data = (await res.json()) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
          };
          const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
          if (!text.trim()) throw new Error("gemini returned empty response");
          return text;
        }
      } catch (err) {
        if ((err as { fatal?: boolean }).fatal) throw err;
        lastErr = err as Error;
      }
      if (attempt < 2) await sleep(delay * (attempt + 1));
    }
    throw lastErr;
  };
}

export function geminiFromEnv(env: NodeJS.ProcessEnv = process.env): ModelCaller {
  const apiKey = env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  if (!model) throw new Error("GEMINI_MODEL is not set (confirm the current Flash id in Google AI Studio)");
  return makeGeminiCaller({ apiKey, model });
}
