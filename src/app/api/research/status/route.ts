import { json } from "@/lib/api-guard";
import { getRecentRuns } from "@/lib/data";
import { checkRate, clientKey, STATUS_LIMIT, tooMany } from "@/lib/rate-limit";
import { researchResult } from "@/lib/research";

export const dynamic = "force-dynamic";

/** Where the newest run stands, in plain words. `since` (ms) is when this person pressed the button, so an older run is never shown as theirs. */
export async function GET(req: Request) {
  const rate = checkRate(STATUS_LIMIT, clientKey(req));
  if (!rate.ok) return tooMany(rate.retryAfterSec);
  const raw = new URL(req.url).searchParams.get("since");
  const since = raw !== null && /^\d{10,14}$/.test(raw) ? Number(raw) : null;
  const runs = await getRecentRuns(3).catch(() => null);
  if (runs === null) return json({ error: "Run history could not be read right now." }, 503);
  return json(researchResult(runs[0] ?? null, since));
}
