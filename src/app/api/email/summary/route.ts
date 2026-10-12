import { guarded, json } from "@/lib/api-guard";
import { sendSummary } from "@/lib/email-summary";
import { EMAIL_LIMIT } from "@/lib/rate-limit";
import { makeSupabaseStore } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Email Summary: sends the latest saved report to the configured recipient, after an explicit confirmation. See src/lib/email-summary.ts for the rules. */
export async function POST(req: Request) {
  return guarded(req, "member", async (visitor, team, body) => {
    const r = await sendSummary(body, { store: makeSupabaseStore(), team, env: process.env, actor: visitor.email });
    return r.ok ? json(r) : json({ error: r.error, code: r.code }, r.status);
  }, { limit: EMAIL_LIMIT });
}
