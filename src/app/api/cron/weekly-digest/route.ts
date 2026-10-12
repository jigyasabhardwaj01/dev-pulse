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

  // Optional ?asOf=YYYY-MM-DD lets you backfill a prior week to seed a trend baseline.
  const asOfParam = new URL(req.url).searchParams.get("asOf");
  const now = asOfParam ? new Date(`${asOfParam}T12:00:00Z`) : new Date();
  if (Number.isNaN(now.getTime())) return NextResponse.json({ error: "bad asOf" }, { status: 400 });

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
      // backfills (asOf) must not email Sumit a stale brief
      sendEmail: asOfParam ? undefined : (args) => sendBriefEmail(args),
      now,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("weekly digest failed:", e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
