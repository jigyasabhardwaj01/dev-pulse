import { after } from "next/server";
import { guarded, json } from "@/lib/api-guard";
import { runDigest } from "@/lib/pipeline";
import { HEAVY_LIMIT } from "@/lib/rate-limit";
import { researchGate } from "@/lib/research";
import { getRecentRuns } from "@/lib/data";
import { productionRunDeps } from "@/lib/run-deps";
import { makeSupabaseStore } from "@/lib/store";
import { ACTIVE_RUN_WINDOW_MS } from "@/lib/run-plan";
import { sanitizeError } from "@/lib/text";
import { periodFor } from "@/lib/week";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Start Research: the manual fallback for the Friday job. Same workflow (collect, AI analysis, rank, save the report), recorded as a
 * manual run, and it never emails. It answers at once and keeps working after the response; the page follows it through the status route.
 */
export async function POST(req: Request) {
  return guarded(req, "member", async () => {
    const store = makeSupabaseStore();
    const now = new Date();
    const deps = productionRunDeps();
    let hasActive = false;
    try { hasActive = await store.hasActiveRun(periodFor(now).weekStart, ACTIVE_RUN_WINDOW_MS); } catch { /* the recorded runs below are checked as well */ }
    const runs = await getRecentRuns(25);
    if (runs === null) return json({ error: "Run history could not be read, so research was not started. Try again in a moment.", code: "no_history" }, 503);
    const gate = researchGate({ now, aiConfigured: deps.callModel !== null, hasActive, runs });
    if (!gate.ok) return json({ error: gate.message, code: gate.code }, gate.status);
    after(async () => {
      try {
        await runDigest({ store, ...deps, trigger: "backfill", invokedBy: "manual", now });
      } catch (e) {
        console.error("manual research failed:", sanitizeError(e)); // the failure is also recorded on the run itself
      }
    });
    return json({ started: true, weekStart: gate.weekStart, startedAt: now.toISOString() }, 202);
  }, { body: false, limit: HEAVY_LIMIT });
}
