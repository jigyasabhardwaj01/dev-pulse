import { json } from "@/lib/api-guard";
import { checkRate, clientKey, READ_EXPORT_LIMIT, tooMany } from "@/lib/rate-limit";
import { currentSession } from "@/lib/session";
import { loadPlan, planMarkdown } from "@/lib/plan-data";
import { sanitizeError } from "@/lib/text";

export const dynamic = "force-dynamic";

/** The Weekly Action Plan as a Markdown file: the same content as the page, read from the saved report and recorded decisions. */
export async function GET(req: Request) {
  const rate = checkRate(READ_EXPORT_LIMIT, clientKey(req));
  if (!rate.ok) return tooMany(rate.retryAfterSec);
  try {
    const plan = await loadPlan(await currentSession());
    return new Response(planMarkdown(plan), {
      headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="jarvis-action-plan${plan.week ? `-${plan.week}` : ""}.md"`, "cache-control": "no-store" },
    });
  } catch (e) {
    console.error("plan export failed:", sanitizeError(e));
    return json({ error: "The plan could not be exported right now. Nothing was changed. Try again in a moment." }, 500);
  }
}
