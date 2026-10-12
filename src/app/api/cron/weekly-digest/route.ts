import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runDigest } from "@/lib/pipeline";
import { makeSupabaseStore } from "@/lib/store";
import { sendBriefEmail } from "@/lib/email";
import { productionRunDeps } from "@/lib/run-deps";
import { ACTIVE_RUN_WINDOW_MS, planRun } from "@/lib/run-plan";
import { periodFor } from "@/lib/week";
import { sanitizeError } from "@/lib/text";
import { alertFor, sendFailureAlert, type AlertRun } from "@/lib/alerts";
import { makeSupabaseTeamStore } from "@/lib/team-store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: an unset secret must never mean "open"
  const given = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Raises a failure alert if the run warrants one. Constructing the store is inside the guard: an alert problem must never fail the run. */
async function raiseAlert(run: AlertRun): Promise<string> {
  if (!alertFor(run)) return "none";
  try { return await sendFailureAlert(makeSupabaseTeamStore(), run, null); } catch (e) { console.error("alert unavailable:", sanitizeError(e)); return "failed"; }
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Optional ?asOf=YYYY-MM-DD (an IST date) runs a backfill for the reporting period that ends at the most recent
  // Friday 00:00 IST on or before it. Backfills never send email.
  const asOfValues = new URL(req.url).searchParams.getAll("asOf");
  const plan = planRun(asOfValues.length === 0 ? null : asOfValues.length === 1 ? asOfValues[0] : asOfValues);
  if ("error" in plan) return NextResponse.json({ error: plan.error }, { status: plan.status });

  const run = productionRunDeps();

  let store: ReturnType<typeof makeSupabaseStore>;
  try {
    store = makeSupabaseStore();
  } catch (e) {
    console.error("store unavailable:", sanitizeError(e));
    return NextResponse.json({ ok: false, error: sanitizeError(e) }, { status: 500 });
  }
  // A duplicated or overlapping trigger (Vercel may deliver a cron more than once) must not repeat a run that is still going.
  // Fail open if the check itself cannot be made: the report, aggregate and email guards still prevent duplicate outcomes.
  const weekStart = periodFor(plan.now).weekStart;
  try {
    if (await store.hasActiveRun(weekStart, ACTIVE_RUN_WINDOW_MS)) {
      console.log(JSON.stringify({ event: "weekly_digest", outcome: "skipped_run_in_progress", weekStart }));
      return NextResponse.json({ ok: true, skipped: "run_in_progress", weekStart }, { status: 202 });
    }
  } catch (e) {
    console.error("active-run check failed (continuing):", sanitizeError(e));
  }

  const started = Date.now();
  try {
    const summary = await runDigest({
      store,
      ...run,
      sendEmail: plan.allowEmail ? (args) => sendBriefEmail(args) : undefined,
      trigger: plan.trigger,
      invokedBy: (req.headers.get("user-agent") ?? "").startsWith("vercel-cron") ? "vercel-cron" : "manual",
      now: plan.now,
    });
    // One structured line per run for the Vercel logs: counts and outcomes only, never credentials or raw errors.
    console.log(JSON.stringify({
      event: "weekly_digest", outcome: summary.status, trigger: summary.trigger, weekStart: summary.weekStart, durationMs: Date.now() - started,
      fetched: summary.fetched, newPosts: summary.newPosts, classified: summary.classified, pending: summary.pending, backlogRemaining: summary.backlogRemaining,
      email: summary.email, brief: summary.brief, sources: Object.fromEntries(Object.entries(summary.sources).map(([k, v]) => [k, v?.status])),
      diagnostics: summary.diagnostics.filter((d) => d.severity !== "info").map((d) => d.code),
    }));
    // Scheduled problems (failed run, email failed/unconfirmed, every source down) raise one bounded, de-duplicated alert. Never throws.
    const alert = await raiseAlert({
      status: summary.status, weekStart: summary.weekStart, trigger: summary.trigger, email: summary.email,
      sources: Object.fromEntries(Object.entries(summary.sources).map(([k, v]) => [k, v?.status])), codes: summary.diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
    });
    if (alert !== "none") console.log(JSON.stringify({ event: "weekly_digest_alert", outcome: alert, weekStart: summary.weekStart }));
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("weekly digest failed:", sanitizeError(e));
    console.log(JSON.stringify({ event: "weekly_digest", outcome: "failed", weekStart, durationMs: Date.now() - started }));
    if (plan.trigger === "scheduled") {
      await raiseAlert({ status: "failed", weekStart, trigger: "scheduled", email: "not_attempted", sources: {}, codes: ["RUN_THREW"] });
    }
    return NextResponse.json({ ok: false, error: sanitizeError(e) }, { status: 500 });
  }
}
