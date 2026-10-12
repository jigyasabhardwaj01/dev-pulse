import { guarded, json } from "@/lib/api-guard";
import { deriveAnalysis } from "@/lib/derive-analysis";
import { HEAVY_LIMIT } from "@/lib/rate-limit";
import { makeSupabaseStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Open to every visitor but tightly rate-limited: derive an immutable analysis for an already-saved report from stored evidence. No source requests, no model calls, no email, no change to the report. */
export async function POST(req: Request) {
  return guarded(req, "owner", async (s, team, body) => {
    const r = await deriveAnalysis(makeSupabaseStore(), team, s, body.weekStart);
    return r.ok ? json({ ok: true, created: r.created, method: r.derived.provenance.method }, r.created ? 201 : 200) : json(r, r.status);
  }, { limit: HEAVY_LIMIT });
}
