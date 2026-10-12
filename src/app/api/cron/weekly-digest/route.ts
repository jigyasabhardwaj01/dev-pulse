import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runDigest } from "@/lib/pipeline";
import { makeSupabaseStore } from "@/lib/store";
import { makeHnFetcher } from "@/lib/sources/hn";
import { makeSoFetcher } from "@/lib/sources/stackoverflow";
import { makeRedditFetcher } from "@/lib/sources/reddit";
import { makeGithubFetcher } from "@/lib/sources/github";
import { geminiFromEnv } from "@/lib/gemini";
import { sendBriefEmail } from "@/lib/email";
import { planRun } from "@/lib/run-plan";

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

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Optional ?asOf=YYYY-MM-DD (an IST date) runs a backfill for the reporting period that ends at the most recent
  // Friday 00:00 IST on or before it. Backfills never send email.
  const asOfValues = new URL(req.url).searchParams.getAll("asOf");
  const plan = planRun(asOfValues.length === 0 ? null : asOfValues.length === 1 ? asOfValues[0] : asOfValues);
  if ("error" in plan) return NextResponse.json({ error: plan.error }, { status: plan.status });

  let callModel = null;
  try {
    callModel = geminiFromEnv();
  } catch (e) {
    console.error("gemini unavailable:", (e as Error).message);
  }

  try {
    const summary = await runDigest({
      store: makeSupabaseStore(),
      fetchers: {
        hn: makeHnFetcher(),
        stackoverflow: makeSoFetcher(fetch, process.env.STACKEXCHANGE_KEY),
        reddit: makeRedditFetcher(),
        github: makeGithubFetcher(fetch, process.env.GITHUB_TOKEN),
      },
      callModel,
      sendEmail: plan.allowEmail ? (args) => sendBriefEmail(args) : undefined,
      trigger: plan.trigger,
      now: plan.now,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("weekly digest failed:", e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
