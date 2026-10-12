import { SOURCE_LABEL } from "./coverage";
import type { Diagnostic } from "./diagnostics";
import type { RunSourceView, RunView } from "./report-model";
import { describeCron, nextWeeklyRun, type ScheduleState } from "./schedule";

/*
 * Pipeline Health: every state shown on /status is computed here from recorded run and source-fetch rows, by the rules in
 * HEALTH_RULES. Unknown stays unknown: a missing record is never turned into zero, success or "healthy".
 */

export const KNOWN_SOURCES = ["hn", "stackoverflow", "reddit", "github"] as const;
export const label = (s: string) => SOURCE_LABEL[s] ?? s;

/** A run is stale for a configured weekly schedule after 7 days plus one day of slack (Hobby cron can fire late and is never retried). */
export const STALE_AFTER_DAYS = 8;
const DAY = 86_400_000;

export type Level = "ok" | "degraded" | "attention" | "unknown";
const SEVERITY: Record<Level, number> = { ok: 0, unknown: 1, degraded: 2, attention: 3 };

// ---------------------------------------------------------------------------------------------------------------
export type SourceState = "records" | "zero" | "partial" | "failed" | "not_checked" | "unknown";

export interface SourceReading {
  source: string;
  name: string;
  state: SourceState;
  /** Short outcome label. */
  headline: string;
  /** What it means for the report. */
  consequence: string;
  capped: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Reads one source in one run. Request counts decide between "partial" and "failed"; they fall back to the stored status only when
 * a run recorded no request counts. "zero" means the requests SUCCEEDED and found nothing, which is not a failure.
 */
export function readSource(s: RunSourceView | undefined, source: string, ctx: { checkedBefore?: boolean } = {}): SourceReading {
  const name = label(source);
  if (!s) {
    return ctx.checkedBefore
      ? { source, name, state: "not_checked", headline: "Not checked in the latest run", consequence: `${name} contributed no records to the latest run, and nothing was recorded for it, so this is not zero posts.`, capped: false }
      : { source, name, state: "unknown", headline: "No status recorded", consequence: `No run has recorded anything for ${name}, so its health is unknown.`, capped: false };
  }
  const capped = s.truncated;
  const why = s.reason ? ` (${s.reason.toLowerCase()})` : "";
  const reqFailed = s.requestsKnown ? s.failedRequests : null;
  const allFailed = s.requestsKnown ? s.failedRequests >= s.requests : s.status === "error";
  const someFailed = s.requestsKnown ? s.failedRequests > 0 : s.status !== "ok";

  if (someFailed && allFailed) {
    return {
      source, name, state: "failed", capped,
      headline: s.requestsKnown ? `All ${s.requests} requests failed${why}` : `Fetch failed${why}`,
      consequence: `No posts were collected, so ${name} is missing from this period's counts. That is a gap, not zero posts.`,
    };
  }
  if (someFailed) {
    const got = s.fetched > 0 ? `${plural(s.fetched, "post", "posts")} were collected` : "the requests that succeeded returned no posts";
    return {
      source, name, state: "partial", capped,
      headline: s.requestsKnown ? `${reqFailed} of ${s.requests} requests failed${why}` : `Partly collected${why}`,
      consequence: `Partial collection: ${got}, so ${name}'s counts may be understated${s.fetched === 0 ? " and it may be hiding real posts" : ""}.`,
    };
  }
  if (s.fetched === 0) {
    return { source, name, state: "zero", capped, headline: "Succeeded, found nothing", consequence: `Every request succeeded and no posts matched in this period, so zero is a real result for ${name}.` };
  }
  return {
    source, name, state: "records", capped,
    headline: `Succeeded: ${plural(s.fetched, "post", "posts")}`,
    consequence: capped ? `Collected successfully, but results hit the page limit, so ${name}'s counts may be understated.` : `Collected successfully; ${plural(s.inserted, "post was", "posts were")} new.`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
export interface SourceTimeline {
  source: string;
  name: string;
  latest: SourceReading;
  lastAttemptAt: string | null;
  /** Latest run where every request succeeded; null when none of the retained runs qualifies. */
  lastCleanAt: string | null;
  /** Consecutive most-recent runs in which this source was partial or failed. */
  problemStreak: number;
  runsChecked: number;
  /** From the latest run's diagnostics: requests retried after transient trouble, and time spent waiting on the provider's rate limit. */
  retries: number;
  waitedMs: number;
}

const startedAt = (r: RunView) => r.startedAt;
const isClean = (st: SourceState) => st === "records" || st === "zero";

/** Runs are newest first. */
export function sourceTimelines(runs: RunView[]): SourceTimeline[] {
  const latest = runs[0];
  return KNOWN_SOURCES.map((source) => {
    const readings = runs.map((r) => ({ r, s: r.sources.find((x) => x.source === source) }));
    const checkedBefore = readings.slice(1).some((x) => x.s);
    const lat = readSource(latest?.sources.find((x) => x.source === source), source, { checkedBefore });
    const states = readings.map((x) => (x.s ? readSource(x.s, source).state : null));
    let streak = 0;
    for (const st of states) { if (st === "partial" || st === "failed") streak++; else break; }
    const attempted = readings.find((x) => x.s);
    const clean = readings.find((x) => x.s && isClean(readSource(x.s, source).state));
    return {
      source, name: label(source), latest: lat,
      lastAttemptAt: attempted ? startedAt(attempted.r) : null,
      lastCleanAt: clean ? startedAt(clean.r) : null,
      problemStreak: streak,
      runsChecked: states.filter((x) => x !== null).length,
      retries: Number(latest?.diagnostics.find((d) => d.source === source && d.code === "SOURCE_RETRIED")?.detail?.retries ?? 0),
      waitedMs: Number(latest?.diagnostics.filter((d) => d.source === source && (d.code === "SOURCE_RETRIED" || d.code === "SOURCE_THROTTLED")).reduce((s, d) => s + Number(d.detail?.waitedMs ?? 0), 0) ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
export interface Tally { clean: number; partial: number; failed: number; notChecked: number; unknown: number }
export function tally(timelines: SourceTimeline[]): Tally {
  const t: Tally = { clean: 0, partial: 0, failed: 0, notChecked: 0, unknown: 0 };
  for (const x of timelines) {
    const s = x.latest.state;
    if (s === "records" || s === "zero") t.clean++; else if (s === "partial") t.partial++; else if (s === "failed") t.failed++; else if (s === "not_checked") t.notChecked++; else t.unknown++;
  }
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
export type StageState = "ok" | "warn" | "bad" | "neutral" | "unknown";
export interface Stage { key: "collect" | "classify" | "summary" | "persist" | "email"; name: string; state: StageState; headline: string; detail: string }

/** Stage-level health, only where the run row records enough to say so. */
export function readStages(run: RunView, tl: SourceTimeline[]): Stage[] {
  const t = tally(tl);
  const collect: Stage = run.sources.length === 0
    ? { key: "collect", name: "Collect", state: "unknown", headline: "Not recorded", detail: "This run recorded no per-source results, so collection health cannot be verified." }
    : t.failed + t.partial + t.notChecked > 0
      ? { key: "collect", name: "Collect", state: t.failed === run.sources.length ? "bad" : "warn", headline: `${t.clean} of ${KNOWN_SOURCES.length} sources clean`, detail: `${t.partial} partial, ${t.failed} failed${t.notChecked ? `, ${t.notChecked} not checked` : ""}. A run can finish with incomplete coverage.` }
      : { key: "collect", name: "Collect", state: "ok", headline: `${t.clean} of ${KNOWN_SOURCES.length} sources clean`, detail: tl.some((x) => x.latest.capped) ? "All requests succeeded; some results hit the page limit." : "Every request succeeded." };

  const classify: Stage = run.classified === null
    ? { key: "classify", name: "Classify", state: "unknown", headline: "Not recorded", detail: "This run did not record classification counts." }
    : (run.unclassified ?? 0) > 0
      ? { key: "classify", name: "Classify", state: "warn", headline: `${run.classified} classified, ${run.unclassified} waiting`, detail: "Waiting posts are retried automatically on the next run and are not in the counts yet." }
      : { key: "classify", name: "Classify", state: "ok", headline: `${run.classified} classified`, detail: "No unclassified posts were left over." };

  const status = run.status;
  const summary: Stage = status === "failed"
    ? { key: "summary", name: "Summary", state: "unknown", headline: "Not verified", detail: "The run failed, so whether a summary was saved is not recorded here." }
    : run.status === "running"
      ? { key: "summary", name: "Summary", state: "unknown", headline: "In progress", detail: "The run has not finished." }
      : run.usedFallback
        ? { key: "summary", name: "Summary", state: "warn", headline: "Template used", detail: "The AI summary was unavailable, so the saved summary was written from a template. The numbers are unaffected." }
        : { key: "summary", name: "Summary", state: "ok", headline: "AI summary written", detail: "The run recorded an AI-written summary (it did not fall back to the template)." };

  const saved = run.diagnostics.find((d) => d.code === "REPORT_SAVED");
  const persist: Stage = saved
    ? { key: "persist", name: "Save", state: "ok", headline: `Version ${saved.detail?.version ?? "?"} ${saved.detail?.action === "create" ? "created" : saved.detail?.action === "replace" ? "replaced" : saved.detail?.action === "unchanged" ? "unchanged" : "kept"}`, detail: "The report was written to the database before anything downstream ran. A delivered report is never overwritten." }
    : run.status === "failed" || run.status === "running"
      ? { key: "persist", name: "Save", state: "unknown", headline: "Not verified", detail: run.status === "failed" ? "The run failed, so whether the report was saved is not recorded here." : "The run has not finished." }
      : run.diagnostics.length > 0
        ? { key: "persist", name: "Save", state: "warn", headline: "Not confirmed", detail: "The run finished but did not record that the report was saved." }
        : { key: "persist", name: "Save", state: "unknown", headline: "Not recorded", detail: "Runs before structured diagnostics did not record the save step." };

  const E = run.emailStatus;
  const email: Stage = E === null ? { key: "email", name: "Email", state: "unknown", headline: "Not recorded", detail: "This run recorded no email outcome." }
    : E === "unconfirmed" ? { key: "email", name: "Email", state: "bad", headline: "Delivery unconfirmed", detail: "The send outcome is unknown and too old to retry safely. Check the inbox before resending." }
    : E === "failed" ? { key: "email", name: "Email", state: "warn", headline: "Failed", detail: "The email was rejected and will be retried by the next scheduled run." }
    : E === "sent" || E === "already_sent" ? { key: "email", name: "Email", state: "ok", headline: E === "sent" ? "Sent" : "Already sent", detail: "The weekly email was accepted by the provider (inbox delivery is not observable here)." }
    : E === "in_progress" ? { key: "email", name: "Email", state: "neutral", headline: "In progress", detail: "Another run holds the delivery claim." }
    : E === "skipped" ? { key: "email", name: "Email", state: "neutral", headline: "Skipped", detail: "No email provider is configured." }
    : { key: "email", name: "Email", state: "neutral", headline: run.trigger === "backfill" ? "Not attempted" : "Not attempted", detail: run.trigger === "backfill" ? "Backfills never send email." : "No email was attempted for this run." };
  return [collect, classify, summary, persist, email];
}

// ---------------------------------------------------------------------------------------------------------------
export interface Reason { level: Level | "note"; text: string }
export interface Health {
  level: Level;
  headline: string;
  summary: string;
  reasons: Reason[];
  latest: RunView | null;
  /** Latest run whose status is "succeeded". "Partial" does not count. */
  lastSuccessful: RunView | null;
  /** Latest run that finished (succeeded or partial). */
  lastCompleted: RunView | null;
  freshness: { state: "not_assessed" | "pending" | "fresh" | "stale" | "unknown"; text: string };
  tally: Tally;
  timelines: SourceTimeline[];
  stages: Stage[];
}

export const HEALTH_RULES: string[] = [
  "Needs attention: the latest run failed or appears stuck; every source failed; an email delivery is unconfirmed; or a schedule is configured and no scheduled run has completed (succeeded or partial) in the last 8 days.",
  "Completed with gaps: the latest run finished as partial; any source was partly collected, failed or not checked; no per-source results were recorded; posts are waiting for classification; the summary fell back to a template; or an email failed.",
  "Working: the latest run succeeded, every source's requests succeeded, nothing is waiting, and no email problem is recorded. Page-limit caps are shown as limits and do not change this.",
  "Not enough information: there are no runs, a run is still in progress, a source has no recorded status, or the run's status is not one this page recognises. Missing data is never counted as zero or as success.",
  "Freshness is only judged when a schedule is configured, and only from scheduled runs (backfills do not count). Before the first scheduled run it is reported as pending, not as a problem. While scheduled runs are paused, the age of the last run is reported but not treated as stale.",
];

const EMPTY_TALLY: Tally = { clean: 0, partial: 0, failed: 0, notChecked: 0, unknown: 0 };

export function ago(iso: string | null | undefined, now: Date): string {
  if (!iso) return "";
  const ms = now.getTime() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  if (ms < 0) return "just now";
  const m = Math.floor(ms / 60_000), h = Math.floor(ms / 3_600_000), d = Math.floor(ms / DAY);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (h < 48) return `${h} h ago`;
  return `${d} days ago`;
}

/** "12 Oct 2026 18:06:42 IST": seconds included so a reload visibly shows fresh data. */
export function formatReadTime(d: Date): string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return `${f.format(d).replace(",", "")} IST`;
}

export function assessHealth({ runs, schedule, now }: { runs: RunView[]; schedule: ScheduleState; now: Date }): Health {
  const latest = runs[0] ?? null;
  const lastSuccessful = runs.find((r) => r.status === "succeeded") ?? null;
  const lastCompleted = runs.find((r) => r.finishedAt && (r.status === "succeeded" || r.status === "partial")) ?? null;
  const timelines = latest ? sourceTimelines(runs) : [];
  const t = latest ? tally(timelines) : EMPTY_TALLY;
  const stages = latest ? readStages(latest, timelines) : [];

  let freshness: Health["freshness"];
  if (schedule.state === "paused") freshness = { state: "not_assessed", text: "Scheduled runs are paused, so the age of the last run is not judged." };
  else if (schedule.state === "unknown") freshness = { state: "unknown", text: "The schedule could not be read, so freshness cannot be judged." };
  else if (!runs.some((r) => r.trigger === "scheduled")) freshness = { state: "pending", text: "A schedule is configured, but its first scheduled run has not happened yet. Earlier runs were backfills." };
  else {
    // The scheduler is working if a scheduled run COMPLETED recently, even partially; how good that run was is judged by the other rules.
    const lastScheduled = runs.find((r) => r.trigger === "scheduled" && r.finishedAt && (r.status === "succeeded" || r.status === "partial"));
    if (!lastScheduled) freshness = { state: "stale", text: "A schedule is configured but no scheduled run has completed." };
    else {
      const age = now.getTime() - new Date(lastScheduled.finishedAt as string).getTime();
      freshness = age > STALE_AFTER_DAYS * DAY
        ? { state: "stale", text: `The last completed scheduled run was more than ${STALE_AFTER_DAYS} days ago.` }
        : { state: "fresh", text: `A scheduled run completed within the last ${STALE_AFTER_DAYS} days.` };
    }
  }

  const reasons: Reason[] = [];
  const add = (level: Reason["level"], text: string) => reasons.push({ level, text });

  if (!latest) {
    add("unknown", "No pipeline runs are recorded.");
  } else {
    const known = ["succeeded", "partial", "failed", "running"].includes(latest.status);
    if (!known) add("unknown", `The latest run has a status this page does not recognise ("${latest.status.slice(0, 20)}"), so it is not treated as healthy.`);
    if (latest.stuck) add("attention", "The latest run appears stuck: it started long ago and never recorded a finish.");
    else if (latest.status === "running") add("unknown", "A run is in progress. Health updates when it finishes.");
    if (latest.status === "failed") add("attention", "The latest run failed.");
    if (latest.status === "partial") add("degraded", "The latest run finished with issues.");
    if (known && latest.status !== "running" && latest.sources.length === 0) add("degraded", "No per-source results were recorded for the latest run, so source health cannot be verified.");
    if (latest.sources.length > 0) {
      if (t.failed === KNOWN_SOURCES.length) add("attention", "Every source failed in the latest run.");
      else {
        if (t.failed > 0) add("degraded", `${plural(t.failed, "source", "sources")} failed in the latest run: ${timelines.filter((x) => x.latest.state === "failed").map((x) => x.name).join(", ")}.`);
        if (t.partial > 0) add("degraded", `${plural(t.partial, "source was", "sources were")} only partly collected: ${timelines.filter((x) => x.latest.state === "partial").map((x) => x.name).join(", ")}.`);
        if (t.notChecked > 0) add("degraded", `${plural(t.notChecked, "source was", "sources were")} not checked in the latest run: ${timelines.filter((x) => x.latest.state === "not_checked").map((x) => x.name).join(", ")}.`);
        if (t.unknown > 0) add("unknown", `${plural(t.unknown, "source has", "sources have")} no recorded status, so ${t.unknown === 1 ? "its" : "their"} health is unknown: ${timelines.filter((x) => x.latest.state === "unknown").map((x) => x.name).join(", ")}.`);
      }
      const capped = timelines.filter((x) => x.latest.capped);
      if (capped.length) add("note", `Results hit the page limit for ${capped.map((x) => x.name).join(" and ")}, so their counts may be understated.`);
    }
    if ((latest.unclassified ?? 0) > 0) add("degraded", `${plural(latest.unclassified ?? 0, "post is", "posts are")} waiting for classification (retried on the next run).`);
    if (latest.classified === null && latest.status !== "running" && latest.status !== "failed") add("note", "Classification counts were not recorded for the latest run.");
    if (latest.usedFallback && latest.status !== "failed") add("degraded", "The latest summary was written from a template because the AI summary was unavailable.");
    if (latest.emailStatus === "unconfirmed") add("attention", "An email delivery is unconfirmed and too old to retry safely. Check the inbox.");
    if (latest.emailStatus === "failed") add("degraded", "The latest email failed and will be retried by the next scheduled run.");
    for (const d of latest.diagnostics) {
      if (d.severity === "error" && ["CLASSIFY_NO_MODEL", "CLASSIFY_ABORTED", "EMAIL_STATE_CHECK_FAILED", "EMAIL_BRIEF_MISSING"].includes(d.code)) add("degraded", d.message);
    }
    if (latest.status === "failed" && lastSuccessful) add("note", "An earlier run did succeed; the latest attempt did not.");
  }
  if (schedule.state === "configured" && freshness.state === "stale") add("attention", freshness.text);
  if (schedule.state === "configured" && freshness.state === "pending") add("note", freshness.text);
  if (schedule.state === "paused") add("note", "Scheduled runs are paused in this deployment.");

  const counted = reasons.filter((r): r is Reason & { level: Level } => r.level !== "note");
  const level: Level = counted.length ? counted.reduce<Level>((m, r) => (SEVERITY[r.level] > SEVERITY[m] ? r.level : m), "ok") : "ok";
  const hasLimits = reasons.some((r) => r.level === "note" && /page limit/.test(r.text));
  const headline = level === "attention" ? "Needs attention" : level === "degraded" ? "Completed with gaps" : level === "unknown" ? "Not enough information" : hasLimits ? "Working, with limits" : "Working";
  const top = counted.sort((a, b) => SEVERITY[b.level] - SEVERITY[a.level])[0];
  const summary = level === "ok" ? "The latest run succeeded and every source answered." : top?.text ?? "";
  return { level, headline, summary, reasons, latest, lastSuccessful, lastCompleted, freshness, tally: t, timelines, stages };
}

// ---------------------------------------------------------------------------------------------------------------
export interface AttentionItem {
  id: string;
  level: "bad" | "warn" | "info";
  what: string;
  where: string;
  /** ISO time of the run this was observed in. */
  when: string | null;
  effect: string;
  next: string;
}

/** Operational issues from the latest run, de-duplicated and ordered by priority. */
export function attentionItems(h: Health): AttentionItem[] {
  const r = h.latest;
  if (!r) return [];
  const out: AttentionItem[] = [];
  const when = r.startedAt;
  if (r.stuck) out.push({ id: "stuck", level: "bad", what: "The run never recorded a finish", where: "Pipeline run", when, effect: "The function was probably killed part-way, so this run's data may be incomplete.", next: "Check the function logs in Vercel for the run time shown." });
  if (r.status === "failed") out.push({ id: "failed", level: "bad", what: "The run failed", where: "Pipeline run", when, effect: "No complete report was produced from this run.", next: "Check the function logs in Vercel; the run's sanitized summary is below." });
  if (r.emailStatus === "unconfirmed") out.push({ id: "email", level: "bad", what: "Email delivery is unconfirmed", where: "Email", when, effect: "The weekly email may or may not have reached the recipient, and it will not be resent automatically.", next: "Check the inbox, then follow the unconfirmed-delivery steps in BACKEND.md." });
  if (r.emailStatus === "failed") out.push({ id: "email-failed", level: "warn", what: "Email delivery failed", where: "Email", when, effect: "The report exists but was not delivered.", next: "The next scheduled run retries it automatically." });
  for (const x of h.timelines) {
    if (x.latest.state !== "partial" && x.latest.state !== "failed" && x.latest.state !== "not_checked") continue;
    const src = r.sources.find((s) => s.source === x.source);
    const rate = src?.reason === "Rate limited by the source";
    out.push({
      id: `src:${x.source}`, level: x.latest.state === "failed" ? "bad" : "warn",
      what: x.latest.headline, where: x.name, when, effect: x.latest.consequence,
      next: x.source === "reddit" && rate
        ? "Expected with Reddit's unauthenticated access, which limits requests. A later run often succeeds; if it keeps happening, OAuth credentials are the documented fix (not set up)."
        : x.latest.state === "not_checked" ? "Check why the source was skipped in the run's technical details." : "See the technical details below; if it repeats on the next run, check the provider's status.",
    });
  }
  const capped = h.timelines.filter((x) => x.latest.capped);
  if (capped.length) out.push({ id: "capped", level: "info", what: `Results hit the page limit`, where: capped.map((x) => x.name).join(", "), when, effect: "Only the newest results are retrieved, so those sources' counts may be understated. This is by design (no paging).", next: "No action needed unless complete counts matter more than free-tier limits." });
  if ((r.unclassified ?? 0) > 0) out.push({ id: "unclassified", level: "warn", what: `${r.unclassified} posts waiting for classification`, where: "Classify", when, effect: "They are not in the counts yet.", next: "They are retried automatically on the next run." });
  if (r.usedFallback && r.status !== "failed") out.push({ id: "fallback", level: "warn", what: "Summary written from a template", where: "Summary", when, effect: "The AI summary was unavailable; the numbers are unaffected.", next: "Check that the Gemini key and quota are healthy." });
  const EFFECT: Record<string, string> = { classify: "Posts stay unclassified and out of the counts until a later run.", email: "No email was sent for this week.", run: "The run's results may be incomplete.", persist: "The report may not have been saved.", summary: "The saved summary is not AI-written.", collect: "Coverage is incomplete." };
  const covered = new Set(["SOURCE_FAILED", "SOURCE_PARTIAL", "SOURCE_RATE_LIMITED", "SOURCE_AUTH", "SOURCE_CAPPED", "CLASSIFY_PENDING", "SUMMARY_FALLBACK", "EMAIL_UNCONFIRMED", "EMAIL_FAILED", "RUN_FAILED", "RUN_BUDGET"]);
  for (const d of r.diagnostics) {
    if (d.severity !== "error" || covered.has(d.code) || out.some((o) => o.id === `diag:${d.code}`)) continue;
    out.push({ id: `diag:${d.code}`, level: "bad", what: d.message, where: d.stage[0].toUpperCase() + d.stage.slice(1), when: d.at, effect: EFFECT[d.stage] ?? "", next: d.remedy ?? "Check the function logs in Vercel." });
  }
  const rank = { bad: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ---------------------------------------------------------------------------------------------------------------
export interface HistoryInsights {
  /** Consecutive newest runs that did not fully succeed (reported only from 2). */
  noSuccessStreak: number;
  recurring: { source: string; name: string; runs: number; of: number; streak: number }[];
  /** Only with at least 3 runs that recorded a duration: a factual range, not a trend claim. */
  duration: { latestSec: number; minSec: number; maxSec: number; of: number } | null;
}

export function historyInsights(runs: RunView[]): HistoryInsights {
  let streak = 0;
  for (const r of runs) { if (r.status === "succeeded") break; if (r.status === "running") continue; streak++; }
  const tl = sourceTimelines(runs);
  const recurring = tl.map((x) => {
    const n = runs.filter((r) => { const s = r.sources.find((y) => y.source === x.source); return s && (readSource(s, x.source).state === "partial" || readSource(s, x.source).state === "failed"); }).length;
    return { source: x.source, name: x.name, runs: n, of: x.runsChecked, streak: x.problemStreak };
  }).filter((x) => x.runs >= 2);
  const durs = runs.map((r) => r.durationSec).filter((d): d is number => typeof d === "number");
  const duration = durs.length >= 3 ? { latestSec: durs[0], minSec: Math.min(...durs), maxSec: Math.max(...durs), of: durs.length } : null;
  return { noSuccessStreak: streak >= 2 ? streak : 0, recurring, duration };
}

export const scheduleText = (s: ScheduleState, now?: Date): { label: string; detail: string; next: Date | null; tone: "ok" | "warn" | "neutral" } =>
  s.state === "paused" ? { label: "Paused", detail: "This deployment has no scheduled runs (no cron in vercel.json). Only a manual, authorised call can start a run.", next: null, tone: "warn" }
  : s.state === "configured" ? { label: "Configured", detail: `${s.crons.map((c) => describeCron(c.schedule)).join("; ")}. Reflects the deployed vercel.json; Vercel's dashboard is the final authority.`, next: now ? (s.crons.map((c) => nextWeeklyRun(c.schedule, now)).filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null) : null, tone: "ok" }
  : { label: "Unknown", detail: "The deployed configuration could not be read.", next: null, tone: "neutral" };
