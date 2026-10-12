import type { FetchResult, FetchedPost, ModelCaller, Source, SourceFetcher, StoredPost, ThemeCount } from "./types";
import { EmailSendError } from "./email";
import { orderTopics, type EmailOutcome, type RunStatus, type SourceFetchRow, type Store } from "./store";
import { periodFor } from "./week";
import { matchesKeywords } from "./matching";
import { dedupePosts } from "./dedupe";
import { classifyTopicPosts, countStoredThemes, countThemes } from "./classify";
import { buildTrends, rankPainPoints } from "./trend";
import { generateBrief } from "./brief";
import { decideBriefWrite, isFrozen, type BriefAction, type BriefDraft } from "./brief-policy";
import { assessComparison, mergeCoverage, summarizeStatuses, type Comparison, type Coverage, type SourceStatus } from "./coverage";
import { sanitizeError } from "./text";
import type { Trigger } from "./run-plan";
import type { ThemeTrend } from "./types";

export interface EmailArgs {
  weekStart: string;
  /** The saved report version. Narrative, points and comparison all come from that one stored version. */
  version: number;
  narrative: string;
  points: ThemeTrend[];
  comparison: Comparison;
  coverage: Coverage;
}

/** "sent" may carry the provider's message id for the delivery record. */
export type SendResult = "sent" | "skipped" | { status: "sent"; messageId?: string | null };

export interface Deps {
  store: Store;
  fetchers: Partial<Record<Source, SourceFetcher>>;
  /** null when Gemini is not configured: classification is skipped and the brief uses the fallback */
  callModel: ModelCaller | null;
  sendEmail?: (args: EmailArgs) => Promise<SendResult>;
  /** Backfills never email, even if a sender is supplied. Defaults to "scheduled". */
  trigger?: Trigger;
  now?: Date;
  clock?: () => number; // injectable for tests
  /** Total time the run plans to use. Vercel's limit for this route is 300 s (route.ts maxDuration). */
  budgetMs?: number;
  /** Injectable for tests; used for the short waits between delivery retries. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunSummary {
  runId: string | null;
  status: RunStatus;
  trigger: Trigger;
  weekStart: string;
  periodStart: string;
  periodEnd: string;
  topics: number;
  fetched: number;
  newPosts: number;
  classified: number;
  /** Unclassified posts inside this reporting period after the run (they are retried next run). */
  pending: number;
  /** Unclassified posts from earlier periods (still inside the lookback) after the run. */
  backlogRemaining: number;
  /** Earlier-period posts classified by this run. */
  recoveredFromEarlierPeriods: number;
  trends: number;
  usedFallbackNarrative: boolean;
  /** What happened to the saved report: created, replaced, unchanged, or kept (frozen / worse rerun). */
  brief: { action: BriefAction; version: number; reason: string };
  email: EmailOutcome;
  comparison: Comparison;
  sources: Coverage;
  warnings: string[];
}

export const DEFAULT_BUDGET_MS = 270_000;
/** Time kept free after classification stops: aggregation, narrative, email and the final status write. */
export const FINALIZE_RESERVE_MS = 90_000;
/** A model call may finish this long after the "do not start new batches" cutoff. */
const CLASSIFY_GRACE_MS = 30_000;
/** The narrative call must be finished this long before the budget ends. */
const NARRATIVE_MARGIN_MS = 30_000;
/** Unclassified posts newer than this are eligible for retry; older ones are left alone. */
export const BACKLOG_LOOKBACK_DAYS = 84;
const DAY = 86_400_000;

const errMsg = (e: unknown) => sanitizeError(e);

function normalize(raw: FetchResult | FetchedPost[]): FetchResult {
  return Array.isArray(raw) ? { posts: raw, requests: 1, failed: 0, errors: [], truncated: false } : raw;
}

/** Monitoring is best-effort: a failure here is noted but must never mask, replace or cause a pipeline error. */
function makeObserver(store: Store, warnings: string[]) {
  const note = (what: string, e: unknown) => {
    console.error(`monitoring: ${what} failed: ${errMsg(e)}`);
    warnings.push(`monitoring: ${what} failed`);
  };
  return {
    async start(info: Parameters<Store["startRun"]>[0]) {
      try { return await store.startRun(info); } catch (e) { note("startRun", e); return null; }
    },
    async sources(runId: string | null, rows: SourceFetchRow[]) {
      if (!runId) return;
      try { await store.recordSourceFetches(runId, rows); } catch (e) { note("recordSourceFetches", e); }
    },
    async finish(runId: string | null, patch: Parameters<Store["finishRun"]>[1]) {
      if (!runId) return;
      try { await store.finishRun(runId, patch); } catch (e) { note("finishRun", e); }
    },
  };
}

/**
 * Brings an earlier period's stored counts up to date with posts classified late. It can only ADD: for every
 * (topic, theme) the result is the larger of the stored and the recomputed value, and nothing is ever removed or
 * lowered. History therefore cannot shrink, whatever has happened to the underlying posts since.
 */
export function growOnly(stored: ThemeCount[], recomputed: ThemeCount[]): { rows: ThemeCount[]; changed: boolean } {
  const key = (c: ThemeCount) => `${c.topic_id}\u0000${c.theme}`;
  const merged = new Map(stored.map((c) => [key(c), { ...c }]));
  let changed = false;
  for (const r of recomputed) {
    const cur = merged.get(key(r));
    if (!cur) { merged.set(key(r), { ...r }); changed = true; continue; }
    if (r.count > cur.count) { cur.count = r.count; changed = true; }
    if (r.unresolved > cur.unresolved) { cur.unresolved = r.unresolved; changed = true; }
  }
  return { rows: [...merged.values()], changed };
}

export async function runDigest(deps: Deps): Promise<RunSummary> {
  const { store, fetchers, callModel } = deps;
  const clock = deps.clock ?? Date.now;
  const t0 = clock();
  const budget = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const trigger: Trigger = deps.trigger ?? "scheduled";
  const period = periodFor(deps.now ?? new Date());
  const warnings: string[] = [];
  const obs = makeObserver(store, warnings);

  const runId = await obs.start({ week_start: period.weekStart, period_start: period.start, period_end: period.end, trigger });
  let fetchRows: SourceFetchRow[] = [];
  let rowsRecorded = false;
  const flushRows = async () => {
    if (rowsRecorded) return;
    rowsRecorded = true;
    await obs.sources(runId, fetchRows);
  };

  try {
    // 2. topics, in a fixed order so overlapping matches are always assigned the same way
    const topics = orderTopics(await store.getActiveTopics());
    const topicNames = Object.fromEntries(topics.map((t) => [t.id, t.name]));

    // 3. fetch every (topic, source) independently; one failed source never blocks the others
    const sources = Object.keys(fetchers) as Source[];
    const jobs = topics.flatMap((t) => sources.map((src) => ({ t, src })));
    const outcomes = await Promise.all(
      jobs.map(async ({ t, src }) => {
        const started = clock();
        try {
          const r = normalize(await fetchers[src]!(t, period));
          const status: SourceStatus = r.requests > 0 && r.failed >= r.requests ? "error" : r.failed > 0 ? "partial" : "ok";
          return { t, src, r, status, error: r.errors.join("; ") || null, ms: clock() - started };
        } catch (e) {
          const r: FetchResult = { posts: [], requests: 1, failed: 1, errors: [errMsg(e)], truncated: false };
          return { t, src, r, status: "error" as SourceStatus, error: errMsg(e), ms: clock() - started };
        }
      }),
    );

    // 4. keep posts inside the period that match the topic's keywords (topic-major order => deterministic)
    const fetchedPosts: FetchedPost[] = [];
    fetchRows = outcomes.map(({ t, src, r, status, error, ms }) => {
      if (status === "error") warnings.push(`${src} fetch failed for "${t.name}": ${error}`);
      else if (status === "partial") warnings.push(`${src} fetch partially failed for "${t.name}": ${error}`);
      if (r.truncated) warnings.push(`${src} results for "${t.name}" hit the page limit; more posts may exist`);
      let accepted = 0;
      for (const p of r.posts) {
        const at = new Date(p.posted_at).getTime();
        if (at < period.start.getTime() || at >= period.end.getTime()) continue;
        if (!matchesKeywords(`${p.title} ${p.body}`, t.keywords)) continue;
        fetchedPosts.push(p);
        accepted += 1;
      }
      return {
        topic_id: t.id, source: src, status, requests: r.requests, failed_requests: r.failed,
        fetched: r.posts.length, accepted, inserted: 0, truncated: r.truncated, error, duration_ms: ms,
      };
    });

    // 5-6. dedupe against stored (source, source_id), then insert
    const existing = await store.getExistingKeys(fetchedPosts);
    const fresh = dedupePosts(fetchedPosts, existing);
    await store.insertPosts(fresh);
    for (const row of fetchRows) {
      row.inserted = fresh.filter((p) => p.topic_id === row.topic_id && p.source === row.source).length;
    }
    await flushRows();

    // 7. classify everything still unclassified: this period first, then earlier periods inside the lookback.
    //    A post stranded by an earlier failure is therefore retried by every later run, under its own period and
    //    topic (both are derived from the post itself). Each validated batch is saved the moment it completes.
    const backlogFrom = new Date(period.start.getTime() - BACKLOG_LOOKBACK_DAYS * DAY);
    const inPeriod = (p: { posted_at: string }) => {
      const t = new Date(p.posted_at).getTime();
      return t >= period.start.getTime() && t < period.end.getTime();
    };
    const unclassified = await store.getUnclassifiedPosts(backlogFrom, period.end);
    const byId = new Map(unclassified.map((p) => [p.id, p]));
    let classified = 0;
    let recovered = 0;
    let pending = unclassified.filter(inPeriod).length;
    let backlogRemaining = unclassified.length - pending;
    const classifyCutoff = t0 + budget - FINALIZE_RESERVE_MS;
    if (unclassified.length && !callModel) {
      warnings.push("GEMINI not configured: classification skipped");
    } else if (unclassified.length && callModel) {
      for (const phase of ["current", "earlier"] as const) {
        for (const topic of topics) {
          const posts: StoredPost[] = unclassified.filter((p) => p.topic_id === topic.id && inPeriod(p) === (phase === "current"));
          if (!posts.length) continue;
          try {
            const out = await classifyTopicPosts(topic, posts, callModel, {
              onBatch: async (results) => {
                await store.saveClassifications(results);
                classified += results.length;
                recovered += results.filter((r) => { const p = byId.get(r.id); return p && !inPeriod(p); }).length;
              },
              canStart: () => clock() < classifyCutoff,
              deadline: classifyCutoff + CLASSIFY_GRACE_MS,
            });
            warnings.push(...out.warnings);
          } catch (e) {
            warnings.push(`classification aborted for "${topic.name}": ${errMsg(e)}`);
          }
        }
      }
      // what is still unclassified is exactly what the next run will retry
      const left = await store.getUnclassifiedPosts(backlogFrom, period.end);
      pending = left.filter(inPeriod).length;
      backlogRemaining = left.length - pending;
    }
    if (recovered) warnings.push(`recovered ${recovered} unclassified post(s) from earlier periods`);

    // 8. reconcile earlier reported periods: late-classified posts are folded into their own period's counts.
    //    Counts only ever grow (growOnly), come from stored classifications as they were made (no re-folding under a
    //    newer vocabulary) and are written only if they changed, so history is never rewritten beyond adding late posts.
    for (const rp of await store.listReportPeriods(backlogFrom)) {
      if (rp.week_start === period.weekStart) continue;
      const start = new Date(rp.period_start);
      const end = new Date(rp.period_end);
      const recomputed = countStoredThemes(await store.getClassifiedPosts(start, end));
      const { rows, changed } = growOnly(await store.getAggregates(rp.week_start), recomputed);
      if (changed) await store.saveAggregates(rp.week_start, rows);
    }

    // 9. this period's aggregates, from stored classifications (idempotent: re-runs recompute, never accumulate)
    const classifiedPosts = await store.getClassifiedPosts(period.start, period.end);
    const current = countThemes(classifiedPosts, topics);
    const sourceCounts = await store.getSourceCounts(period.start, period.end);

    // 10. the previous report counts as a baseline only if it was recorded under this same period convention
    const prevReport = await store.getReportPeriod(period.prevWeekStart);
    const prevValid = prevReport && new Date(prevReport.period_start).getTime() === period.prevStart.getTime() ? prevReport : null;
    const previousRows = prevValid ? await store.getAggregates(period.prevWeekStart) : [];

    const thisReport = await store.getReportPeriod(period.weekStart);
    const sameKey = thisReport && new Date(thisReport.period_start).getTime() === period.start.getTime();
    const runCoverage: Coverage = {};
    for (const src of sources) {
      runCoverage[src] = {
        status: summarizeStatuses(outcomes.filter((o) => o.src === src).map((o) => o.status)),
        posts: sourceCounts[src] ?? 0,
        ...(outcomes.some((o) => o.src === src && o.r.truncated) ? { truncated: true } : {}),
      };
    }
    const coverage = mergeCoverage(sameKey ? (thisReport.coverage?.sources ?? null) : null, runCoverage);
    const comparison = assessComparison(coverage, prevValid ? (prevValid.coverage?.sources ?? {}) : null);

    // Trend maths is unchanged for a fair comparison. Otherwise counts are kept but no trend is asserted.
    let trends = buildTrends(current, previousRows, topicNames);
    if (comparison.state !== "comparable") {
      trends = trends.filter((t) => t.count > 0).map((t) => ({ ...t, direction: "unavailable" as const, pct: null }));
    }
    await store.saveAggregates(period.weekStart, current);
    await store.saveReportPeriod({
      week_start: period.weekStart,
      period_start: period.start.toISOString(),
      period_end: period.end.toISOString(),
      coverage: { sources: coverage, comparison },
    });

    // 11. the saved report: one version that both the dashboard and the email use.
    //     A delivered (or being-delivered) report is frozen, and a rerun that is less complete or would swap an AI
    //     narrative for the fallback never replaces a better one (see brief-policy.ts).
    const points = rankPainPoints(trends, 40); // dashboard shows all; the email caps itself
    const savedBefore = await store.getBrief(period.weekStart);
    let action: BriefAction = "keep";
    let reason = "report is already delivered or being delivered";
    if (!isFrozen(savedBefore)) {
      const { narrative, usedFallback } = await generateBrief(
        trends, { pending, warnings }, callModel, comparison.state, t0 + budget - NARRATIVE_MARGIN_MS,
      );
      const draft: BriefDraft = { narrative, points, coverage: { sources: coverage, comparison }, pendingCount: pending, usedFallback };
      const decision = decideBriefWrite(savedBefore, draft);
      action = decision.action;
      reason = decision.reason;
      if (decision.action === "create" || decision.action === "replace") {
        const res = await store.saveBrief(period.weekStart, draft, savedBefore ? savedBefore.version : null);
        if (!res.saved) {
          action = "keep"; // lost a race: someone else's version stands
          reason = "another run saved or delivered this report first";
        }
      }
    }
    const saved = await store.getBrief(period.weekStart);
    if (!saved) throw new Error("saved report not found after writing it");

    // 12. email: scheduled runs only, at most once per reporting week, built from the SAVED version
    let email: EmailOutcome = "not_attempted";
    if (deps.sendEmail && trigger === "scheduled") {
      email = await deliverOnce(store, deps.sendEmail, {
        weekStart: period.weekStart,
        version: saved.version,
        narrative: saved.narrative,
        points: saved.points,
        comparison: saved.coverage.comparison,
        coverage: saved.coverage.sources,
      }, warnings, deps.sleep);
    }

    const problems = outcomes.some((o) => o.status !== "ok") || pending > 0 || backlogRemaining > 0 || email === "failed" || email === "unconfirmed";
    const status: RunStatus = problems ? "partial" : "succeeded";
    await obs.finish(runId, {
      status, fetched_total: fetchedPosts.length, new_posts: fresh.length, classified_ok: classified,
      classification_failed: pending + backlogRemaining, used_fallback: saved.usedFallback, email_status: email, warnings,
    });

    return {
      runId, status, trigger,
      weekStart: period.weekStart, periodStart: period.start.toISOString(), periodEnd: period.end.toISOString(),
      topics: topics.length, fetched: fetchedPosts.length, newPosts: fresh.length, classified, pending, backlogRemaining,
      recoveredFromEarlierPeriods: recovered, trends: trends.length, usedFallbackNarrative: saved.usedFallback,
      brief: { action, version: saved.version, reason },
      email, comparison: saved.coverage.comparison, sources: coverage, warnings,
    };
  } catch (e) {
    // Record the failure, then surface the ORIGINAL error. Recording problems are only noted.
    await flushRows();
    await obs.finish(runId, { status: "failed", warnings, error: errMsg(e) });
    throw e;
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Retries use the SAME idempotency key, so a message the provider already accepted is not sent twice. */
const SEND_BACKOFF_MS = [1_000, 4_000];
const MARK_BACKOFF_MS = [500, 1_500];

/**
 * Sends the weekly email at most once per reporting week, using the already-saved report version.
 *
 * - The claim is one atomic conditional update, so overlapping requests cannot both send.
 * - A send whose outcome is unknown (timeout, network error, 5xx, 409) is retried a couple of times with the SAME
 *   idempotency key. If it still cannot be settled the claim stays "sending": it is NOT marked failed, because the message
 *   may have been accepted.
 * - "sent" is recorded only after the provider accepted; that write is retried. If it still fails the claim stays "sending".
 * - A claim left in "sending" may be retaken only after its 15 min lease and only while the provider still remembers the
 *   idempotency key (store.EMAIL_KEY_SAFE_MS). Older than that it is reported "unconfirmed" and never resent automatically.
 *
 * Not exactly-once, but a duplicate now needs a person to resend by hand. A definite rejection (4xx) is marked failed and
 * retried by the next run.
 */
async function deliverOnce(
  store: Store,
  send: NonNullable<Deps["sendEmail"]>,
  args: EmailArgs,
  warnings: string[],
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<EmailOutcome> {
  let claim;
  try {
    claim = await store.claimEmail(args.weekStart);
  } catch (e) {
    warnings.push(`email not sent: could not check delivery state (${errMsg(e)})`); // fail closed: never send unguarded
    return "failed";
  }
  if (claim === "already_sent") return "already_sent";
  if (claim === "in_progress") return "in_progress";
  if (claim === "unconfirmed") {
    warnings.push("email not sent: an earlier delivery attempt for this week is unconfirmed and is too old to retry safely; check the inbox before resending");
    return "unconfirmed";
  }
  if (claim === "no_brief") {
    warnings.push("email not sent: brief row missing");
    return "failed";
  }

  let result: SendResult | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await send(args);
      break;
    } catch (e) {
      const ambiguous = e instanceof EmailSendError && !e.definite;
      if (ambiguous && attempt < SEND_BACKOFF_MS.length) { await sleep(SEND_BACKOFF_MS[attempt]); continue; }
      if (ambiguous) {
        warnings.push(`email outcome unknown after ${attempt + 1} attempts (${errMsg(e)}); claim kept so it is not resent after the provider forgets the key`);
        return "unconfirmed";
      }
      warnings.push(`email failed: ${errMsg(e)}`);
      try { await store.markEmailFailed(args.weekStart, errMsg(e)); } catch (m) { warnings.push(`monitoring: markEmailFailed failed (${errMsg(m)})`); }
      return "failed";
    }
  }
  if (result === "skipped") {
    try { await store.releaseEmailClaim(args.weekStart); } catch (m) { warnings.push(`monitoring: releaseEmailClaim failed (${errMsg(m)})`); }
    return "skipped";
  }
  const messageId = typeof result === "object" ? (result.messageId ?? null) : null;
  for (let attempt = 0; ; attempt++) {
    try {
      await store.markEmailSent(args.weekStart, args.version, messageId);
      return "sent";
    } catch (m) {
      if (attempt < MARK_BACKOFF_MS.length) { await sleep(MARK_BACKOFF_MS[attempt]); continue; }
      warnings.push(`email was accepted but could not be recorded as sent after ${attempt + 1} attempts (${errMsg(m)}); claim kept (not resent automatically once the provider's key window passes)`);
      return "sent";
    }
  }
}
