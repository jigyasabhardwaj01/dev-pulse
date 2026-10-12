// Post-migration check: many TRULY concurrent requests through PostgREST must produce exactly one winner.
// NOT part of the app and NOT run automatically. Run only after migrations 003 + 004 are applied:
//   set -a; . ./.env.local; set +a; node scripts/verify-claim-concurrency.mjs
// It writes ONE throw-away row (week_start 2099-12-31) and removes it afterwards. It sends no email.
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const WEEK = "2099-12-31";
const TABLE = process.env.CONC_TABLE ?? "briefs"; // CONC_TABLE lets the check run against a disposable clone before migrations are applied
const N = 25;
const fail = [];
// timing: proves the requests were in flight together (start spread vs. duration)
const timed = (fn) => async () => { const t0 = performance.now(); const r = await fn(); return { r, t0, t1: performance.now() }; };
const overlap = (label, arr) => { const lastStart = Math.max(...arr.map((x) => x.t0)); const firstEnd = Math.min(...arr.map((x) => x.t1)); check(`${label}: all requests overlapped in flight`, lastStart < firstEnd, `last start +${(lastStart - Math.min(...arr.map((x) => x.t0))).toFixed(0)}ms, first finish +${(firstEnd - Math.min(...arr.map((x) => x.t0))).toFixed(0)}ms`); return arr.map((x) => x.r); };
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) fail.push(label); };

// the exact shapes used by src/lib/store.ts
const claim = () => {
  const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  return db.from(TABLE).update({ email_status: "sending", email_claimed_at: new Date().toISOString(), email_error: null })
    .eq("week_start", WEEK)
    .or(`email_status.is.null,email_status.eq.failed,and(email_status.eq.sending,email_claimed_at.lt.${staleBefore})`)
    .select("week_start");
};
const replace = (i) => db.from(TABLE).update({ narrative: `writer ${i}`, version: 2 })
  .eq("week_start", WEEK).eq("version", 1).or("email_status.is.null,email_status.eq.failed").select("version");

try {
  await db.from(TABLE).delete().eq("week_start", WEEK); // clean any leftover from a previous aborted run
  const ins = await db.from(TABLE).insert({ week_start: WEEK, narrative: "scratch", top_pain_points: [], version: 1 });
  if (ins.error) throw new Error("setup failed: " + ins.error.message);

  // 1. N parallel creators: exactly one insert wins
  const creators = await Promise.all(Array.from({ length: N }, () => db.from(TABLE).upsert({ week_start: WEEK, narrative: "x" }, { onConflict: "week_start", ignoreDuplicates: true }).select("version")));
  check("create race: nobody inserts a second row", creators.every((r) => !r.error && r.data.length === 0));

  // 2. N parallel compare-and-set writers at version 1: exactly one wins
  const writers = overlap("compare-and-set", await Promise.all(Array.from({ length: N }, (_, i) => timed(() => replace(i))())));
  const won = writers.filter((r) => !r.error && r.data.length === 1).length;
  check(`compare-and-set race: exactly 1 of ${N} writers wins`, won === 1, `winners=${won} errors=${writers.filter((r) => r.error).length}`);

  // 3. N parallel email claims: exactly one winner
  const claims = overlap("email claim", await Promise.all(Array.from({ length: N }, () => timed(() => claim())())));
  const claimed = claims.filter((r) => !r.error && r.data.length === 1).length;
  check(`email claim race: exactly 1 of ${N} claims wins`, claimed === 1, `winners=${claimed} errors=${claims.filter((r) => r.error).length}`);

  // 4. while 'sending', content writes are rejected by the trigger and replace/claim match nothing
  const blocked = await db.from(TABLE).update({ narrative: "tamper" }).eq("week_start", WEEK);
  check("content change while sending is rejected by the trigger", !!blocked.error && /immutable|check/i.test(blocked.error.message), blocked.error?.message ?? "no error");
  check("a further claim matches nothing", (await claim()).data?.length === 0);

  // 5. release the claim so the scratch row can be removed
  await db.from(TABLE).update({ email_status: null, email_claimed_at: null }).eq("week_start", WEEK).eq("email_status", "sending");
} catch (e) {
  fail.push("script error"); console.error("ERROR:", e.message);
} finally {
  const del = await db.from(TABLE).delete().eq("week_start", WEEK);
  const left = await db.from(TABLE).select("week_start").eq("week_start", WEEK);
  console.log(`cleanup: scratch row removed = ${!del.error && left.data?.length === 0}`);
}
console.log(fail.length ? `\n${fail.length} CHECK(S) FAILED: ${fail.join("; ")}` : "\nALL CONCURRENCY CHECKS PASSED");
process.exit(fail.length ? 1 : 0);
