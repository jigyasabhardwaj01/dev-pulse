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
import { coarseReason, makeDiagnostics, type Diagnostic } from "./diagnostics";
import { SOURCE_LABEL } from "./coverage";
import { analyse, BASELINE_WEEKS, type PriorWeek } from "./analysis";
import { advance, planFetch, type Checkpoint } from "./checkpoints";
import { buildFridayBrief, type FridayBrief } from "./friday-brief";
import { classificationPolicy, effectiveTopic, matchPost, snapshotConfig } from "./watchlist";
import { formatPeriod } from "./view";
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
  /** The structured Friday brief, built from the SAVED version's sealed analysis (never regenerated at send time). Null for reports saved before it existed. */
  brief?: FridayBrief | null;
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
  /** Structured diagnostics with stable codes (safe messages only). Also stored with the run. */
  diagnostics: Diagnostic[];
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
type Diag = ReturnType<typeof makeDiagnostics>;
const srcName = (s: string) => SOURCE_LABEL[s] ?? s;

function normalize(raw: FetchResult | FetchedPost[]): FetchResult {
  return Array.isArray(raw) ? { posts: raw, requests: 1, failed: 0, errors: [], truncated: false } : raw;
}

/** Monitoring is best-effort: a failure here is noted but must never mask, replace or cause a pipeline error. */
function makeObserver(store: Store, diag: Diag) {
  const note = (what: string, e: unknown) => {
    console.error(`monitoring: ${what} failed: ${errMsg(e)}`);
    diag.add({ code: "MONITORING_FAILED", severity: "warning", stage: "run", message: `Run history could not be written (${what}); the pipeline itself was not affected.` }, `monitoring: ${what} failed`);
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
  const diag = makeDiagnostics(() => Date.now(), warnings);
  const obs = makeObserver(store, diag);

  let configSnapshotForFailure: ReturnType<typeof snapshotConfig> | undefined;
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
    const watch = await store.getWatchConfig();
    const sensitivity = watch.sensitivity;
    const policy = classificationPolicy(sensitivity);
    // `keywords` of each topic is now the ACTIVE watchlist include terms, so every adapter queries what the owner configured.
    const topics = orderTopics(await store.getActiveTopics()).map((t) => effectiveTopic(t, watch.terms));
    const topicNames = Object.fromEntries(topics.map((t) => [t.id, t.name]));
    const configSnapshot = snapshotConfig(topics, sensitivity, deps.now ?? new Date());
    configSnapshotForFailure = configSnapshot;

    // checkpoints: what has already been collected COMPLETELY and stored (unreadable checkpoints just mean "fetch everything")
    const cps = new Map<string, Checkpoint>();
    try {
      for (const c of await store.getCheckpoints()) cps.set(`${c.source}|${c.topic_id}`, c);
    } catch (e) {
      diag.add({ code: "MONITORING_FAILED", severity: "warning", stage: "collect", message: "Collection checkpoints could not be read, so every window is fetched in full." }, `checkpoints unreadable: ${errMsg(e)}`);
    }

    // 3. fetch every (topic, source) independently; one failed source never blocks the others
    const sources = Object.keys(fetchers) as Source[];
    const jobs = topics.flatMap((t) => sources.map((src) => ({ t, src })));
    const outcomes = await Promise.all(
      jobs.map(async ({ t, src }) => {
        const started = clock();
        const plan = planFetch(cps.get(`${src}|${t.id}`), period);
        if (plan.action === "skip") {
          const r: FetchResult = { posts: [], requests: 0, failed: 0, errors: [], truncated: false };
          return { t, src, r, status: "ok" as SourceStatus, error: null, ms: 0, skipped: true, window: null as { start: Date; end: Date } | null };
        }
        const window = plan.window;
        try {
          const r = normalize(await fetchers[src]!(t, { ...period, start: window.start, end: window.end }));
          const status: SourceStatus = r.requests > 0 && r.failed >= r.requests ? "error" : r.failed > 0 ? "partial" : "ok";
          return { t, src, r, status, error: r.errors.join("; ") || null, ms: clock() - started, skipped: false, window: window as { start: Date; end: Date } | null };
        } catch (e) {
          const r: FetchResult = { posts: [], requests: 1, failed: 1, errors: [errMsg(e)], truncated: false };
          return { t, src, r, status: "error" as SourceStatus, error: errMsg(e), ms: clock() - started, skipped: false, window: window as { start: Date; end: Date } | null };
        }
      }),
    );

    // 4. keep posts inside the period that match the topic's keywords (topic-major order => deterministic)
    const fetchedPosts: FetchedPost[] = [];
    const filtered = { excluded: 0, belowSensitivity: 0 };
    fetchRows = outcomes.map(({ t, src, r, status, error, ms }) => {
      if (status === "error" || status === "partial") {
        const why = coarseReason(error);
        const auth = /rejected the API credentials/.test(error ?? "");
        const limited = why === "Rate limited by the source";
        diag.add({
          code: auth ? "SOURCE_AUTH" : limited ? "SOURCE_RATE_LIMITED" : status === "error" ? "SOURCE_FAILED" : "SOURCE_PARTIAL",
          severity: status === "error" ? "error" : "warning", stage: "collect", source: src,
          message: `${srcName(src)} ${status === "error" ? "failed" : "was only partly collected"} for "${t.name}": ${auth ? "the API credentials were rejected" : (why ?? "unknown reason").toLowerCase()}.`,
          detail: { requests: r.requests, failed: r.failed, fetched: r.posts.length },
        }, `${src} fetch ${status === "error" ? "failed" : "partially failed"} for "${t.name}": ${error}`);
      }
      if (r.truncated) warnings.push(`${src} results for "${t.name}" hit the page limit; more posts may exist`);
      let accepted = 0;
      for (const p of r.posts) {
        const at = new Date(p.posted_at).getTime();
        if (at < period.start.getTime() || at >= period.end.getTime()) continue;
        // the watchlist decides: active terms, exclusions and the sensitivity mode (deterministic; see watchlist.matchPost)
        const m = matchPost(p, t, sensitivity);
        if (!m.accepted) {
          if (m.reason === "excluded") filtered.excluded++;
          else if (m.reason === "below_sensitivity") filtered.belowSensitivity++;
          continue;
        }
        fetchedPosts.push({ ...p, matched_terms: m.terms, flags: m.flags });
        accepted += 1;
      }
      return {
        topic_id: t.id, source: src, status, requests: r.requests, failed_requests: r.failed,
        fetched: r.posts.length, accepted, inserted: 0, truncated: r.truncated, error, duration_ms: ms,
      };
    });

    // one diagnostic per source (not per topic) for caps, retries and rate-limit waiting
    for (const src of sources) {
      const mine = outcomes.filter((o) => o.src === src);
      const capped = mine.filter((o) => o.r.truncated).length;
      if (capped) diag.add({ code: "SOURCE_CAPPED", severity: "info", stage: "collect", source: src, message: `${srcName(src)} results hit the page limit for ${capped} of ${mine.length} topics, so its counts may be understated.`, detail: { topics: mine.length, capped } }, null);
      const retries = mine.reduce((s, o) => s + (o.r.retries ?? 0), 0);
      const waitedMs = mine.reduce((s, o) => s + (o.r.waitedMs ?? 0), 0);
      if (retries > 0 || waitedMs > 0) {
        diag.add({
          code: retries > 0 ? "SOURCE_RETRIED" : "SOURCE_THROTTLED", severity: "info", stage: "collect", source: src,
          message: `${srcName(src)}: ${retries > 0 ? `${retries} ${retries === 1 ? "request was" : "requests were"} retried after transient trouble; ` : ""}waited ${Math.round(waitedMs / 1000)} s in total for the provider's rate limit.`,
          detail: { retries, waitedMs },
        }, null);
      }
    }

    for (const src of sources) {
      const skipped = outcomes.filter((o) => o.src === src && o.skipped).length;
      if (skipped) diag.add({ code: "SOURCE_SKIPPED", severity: "info", stage: "collect", source: src, message: `${srcName(src)} was already collected completely for this period (checkpoint), so it was not fetched again for ${skipped} of ${outcomes.filter((o) => o.src === src).length} topics.`, detail: { skipped } }, null);
    }
    if (filtered.excluded || filtered.belowSensitivity) {
      diag.add({ code: "WATCH_FILTERED", severity: "info", stage: "collect", message: `The watchlist removed ${filtered.excluded} ${filtered.excluded === 1 ? "post" : "posts"} by exclusion and ${filtered.belowSensitivity} below the ${sensitivity} evidence threshold.`, detail: { excluded: filtered.excluded, belowSensitivity: filtered.belowSensitivity } }, null);
    }

    // 5-6. dedupe against stored (source, source_id), then insert
    const existing = await store.getExistingKeys(fetchedPosts);
    const fresh = dedupePosts(fetchedPosts, existing);
    await store.insertPosts(fresh);
    for (const row of fetchRows) {
      row.inserted = fresh.filter((p) => p.topic_id === row.topic_id && p.source === row.source).length;
    }
    await flushRows();

    // Checkpoints advance ONLY now, after the data they cover was stored. A failure, a partial fetch or a page cap leaves them
    // where they were, so the next run starts from the same place and nothing is skipped.
    try {
      const now = deps.now ?? new Date(); // the run's LOGICAL time (a backfill is "as of" its date), not the wall clock
      const moved = outcomes.filter((o) => !o.skipped && o.window).map((o) => advance(cps.get(`${o.src}|${o.t.id}`), o.src, o.t.id, o.window!, { status: o.status, truncated: o.r.truncated }, now));
      await store.saveCheckpoints(moved);
    } catch (e) {
      diag.add({ code: "MONITORING_FAILED", severity: "warning", stage: "collect", message: "Collection checkpoints could not be saved; the next run fetches these windows again (nothing is skipped)." }, `checkpoints not saved: ${errMsg(e)}`);
    }

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
      diag.add({ code: "CLASSIFY_NO_MODEL", severity: "error", stage: "classify", message: `Classification was skipped because no Gemini key is configured; ${unclassified.length} posts stay unclassified.`, detail: { waiting: unclassified.length } }, "GEMINI not configured: classification skipped");
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
              policy,
            });
            if (out.failures.length) {
              try { await store.saveClassificationFailures(out.failures); } catch (e) { warnings.push(`classification failure reasons not saved: ${errMsg(e)}`); }
            }
            warnings.push(...out.warnings);
            if (out.warnings.length) diag.add({ code: "CLASSIFY_WARNING", severity: "warning", stage: "classify", message: `Classification reported ${out.warnings.length} ${out.warnings.length === 1 ? "problem" : "problems"} for "${topic.name}" (details in the server logs).`, detail: { count: out.warnings.length } }, null);
          } catch (e) {
            diag.add({ code: "CLASSIFY_ABORTED", severity: "error", stage: "classify", message: `Classification stopped for "${topic.name}"; its remaining posts stay unclassified and are retried next run.` }, `classification aborted for "${topic.name}": ${errMsg(e)}`);
          }
        }
      }
      // what is still unclassified is exactly what the next run will retry
      const left = await store.getUnclassifiedPosts(backlogFrom, period.end);
      pending = left.filter(inPeriod).length;
      backlogRemaining = left.length - pending;
      if (pending + backlogRemaining > 0) {
        diag.add({ code: "CLASSIFY_PENDING", severity: "warning", stage: "classify", message: `${pending} ${pending === 1 ? "post" : "posts"} in this period and ${backlogRemaining} from earlier periods are waiting for classification.`, detail: { pending, backlogRemaining } }, null);
        if (clock() >= classifyCutoff) diag.add({ code: "RUN_BUDGET", severity: "warning", stage: "run", message: "The run's time budget was reached, so it stopped starting new classification work." }, null);
      }
    }
    if (recovered) diag.add({ code: "CLASSIFY_RECOVERED", severity: "info", stage: "classify", message: `Recovered ${recovered} unclassified ${recovered === 1 ? "post" : "posts"} from earlier periods.`, detail: { recovered } }, `recovered ${recovered} unclassified post(s) from earlier periods`);

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
      if (usedFallback) diag.add({ code: "SUMMARY_FALLBACK", severity: "warning", stage: "summary", message: "The AI summary was unavailable, so the summary was written from a template. The numbers are unaffected." }, null);
      // the sealed analysis: aggregation, ranking, baseline and limitations, built from stored evidence and earlier weeks
      let prior: PriorWeek[] = [];
      try { prior = await store.getPriorWeeks(period.weekStart, BASELINE_WEEKS); } catch (e) { diag.add({ code: "MONITORING_FAILED", severity: "warning", stage: "summary", message: "Earlier weeks could not be read, so no baseline is shown in this report." }, `prior weeks unreadable: ${errMsg(e)}`); }
      const analysis = analyse({ weekStart: period.weekStart, posts: await store.getEvidencePosts(period.start, period.end), trends, topicNames, coverage, comparison: comparison.state, prior, pendingPosts: pending });
      const draft: BriefDraft = { narrative, points, coverage: { sources: coverage, comparison }, pendingCount: pending, usedFallback, configSnapshot, analysis };
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
    diag.add({ code: "REPORT_SAVED", severity: "info", stage: "persist", message: `Report ${period.weekStart}: ${action === "create" ? "created" : action === "replace" ? "replaced with a newer version" : action === "unchanged" ? "unchanged" : "kept as already saved"} (version ${saved.version}).`, detail: { action, version: saved.version, pending } }, null);

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
        brief: saved.analysis ? buildFridayBrief({ weekStart: period.weekStart, periodLabel: formatPeriod(period.weekStart), analysis: saved.analysis, narrative: saved.narrative, usedFallback: saved.usedFallback }) : null,
      }, diag, deps.sleep);
    }

    const problems = outcomes.some((o) => o.status !== "ok") || pending > 0 || backlogRemaining > 0 || email === "failed" || email === "unconfirmed";
    const status: RunStatus = problems ? "partial" : "succeeded";
    await obs.finish(runId, {
      status, fetched_total: fetchedPosts.length, new_posts: fresh.length, classified_ok: classified,
      classification_failed: pending + backlogRemaining, used_fallback: saved.usedFallback, email_status: email, warnings, diagnostics: diag.items, config_snapshot: configSnapshot,
    });

    return {
      runId, status, trigger,
      weekStart: period.weekStart, periodStart: period.start.toISOString(), periodEnd: period.end.toISOString(),
      topics: topics.length, fetched: fetchedPosts.length, newPosts: fresh.length, classified, pending, backlogRemaining,
      recoveredFromEarlierPeriods: recovered, trends: trends.length, usedFallbackNarrative: saved.usedFallback,
      brief: { action, version: saved.version, reason },
      email, comparison: saved.coverage.comparison, sources: coverage, warnings, diagnostics: diag.items,
    };
  } catch (e) {
    // Record the failure, then surface the ORIGINAL error. Recording problems are only noted.
    await flushRows();
    diag.add({ code: "RUN_FAILED", severity: "error", stage: "run", message: "The run failed before it could complete. See the server logs for the cause." }, null);
    await obs.finish(runId, { status: "failed", warnings, diagnostics: diag.items, ...(configSnapshotForFailure ? { config_snapshot: configSnapshotForFailure } : {}), error: errMsg(e) });
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
  diag: Diag,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<EmailOutcome> {
  let claim;
  try {
    claim = await store.claimEmail(args.weekStart);
  } catch (e) {
    diag.add({ code: "EMAIL_STATE_CHECK_FAILED", severity: "error", stage: "email", message: "Email not sent: the delivery state could not be checked, so nothing was sent." }, `email not sent: could not check delivery state (${errMsg(e)})`); // fail closed: never send unguarded
    return "failed";
  }
  if (claim === "already_sent") { diag.add({ code: "EMAIL_ALREADY_SENT", severity: "info", stage: "email", message: "This week's report was already emailed, so nothing was sent again." }, null); return "already_sent"; }
  if (claim === "in_progress") return "in_progress";
  if (claim === "unconfirmed") {
    diag.add({ code: "EMAIL_UNCONFIRMED", severity: "error", stage: "email", message: "Email not sent: an earlier delivery attempt for this week is unconfirmed and too old to retry safely. Check the inbox before resending." }, "email not sent: an earlier delivery attempt for this week is unconfirmed and is too old to retry safely; check the inbox before resending");
    return "unconfirmed";
  }
  if (claim === "no_brief") {
    diag.add({ code: "EMAIL_BRIEF_MISSING", severity: "error", stage: "email", message: "Email not sent: the saved report could not be found." }, "email not sent: brief row missing");
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
        diag.add({ code: "EMAIL_OUTCOME_UNKNOWN", severity: "error", stage: "email", message: `The email provider did not confirm the send after ${attempt + 1} attempts. The claim is kept so it is not resent after the provider forgets the key.`, detail: { attempts: attempt + 1 } }, `email outcome unknown after ${attempt + 1} attempts (${errMsg(e)}); claim kept so it is not resent after the provider forgets the key`);
        return "unconfirmed";
      }
      diag.add({ code: "EMAIL_FAILED", severity: "warning", stage: "email", message: "The email provider rejected the message. It will be retried by the next scheduled run." }, `email failed: ${errMsg(e)}`);
      try { await store.markEmailFailed(args.weekStart, errMsg(e)); } catch (m) { diag.add({ code: "MONITORING_FAILED", severity: "warning", stage: "email", message: "The failed-email state could not be recorded." }, `monitoring: markEmailFailed failed (${errMsg(m)})`); }
      return "failed";
    }
  }
  if (result === "skipped") {
    try { await store.releaseEmailClaim(args.weekStart); } catch (m) { diag.add({ code: "MONITORING_FAILED", severity: "warning", stage: "email", message: "The email claim could not be released." }, `monitoring: releaseEmailClaim failed (${errMsg(m)})`); }
    return "skipped";
  }
  const messageId = typeof result === "object" ? (result.messageId ?? null) : null;
  for (let attempt = 0; ; attempt++) {
    try {
      await store.markEmailSent(args.weekStart, args.version, messageId);
      diag.add({ code: "EMAIL_SUBMITTED", severity: "info", stage: "email", message: `The provider accepted the email for report version ${args.version}. Inbox delivery is not observable here.`, detail: { version: args.version } }, null);
      return "sent";
    } catch (m) {
      if (attempt < MARK_BACKOFF_MS.length) { await sleep(MARK_BACKOFF_MS[attempt]); continue; }
      diag.add({ code: "EMAIL_MARK_SENT_FAILED", severity: "warning", stage: "email", message: `The email was accepted but could not be recorded as sent after ${attempt + 1} attempts. The claim is kept; it is not resent automatically once the provider's key window passes.`, detail: { attempts: attempt + 1 } }, `email was accepted but could not be recorded as sent after ${attempt + 1} attempts (${errMsg(m)}); claim kept (not resent automatically once the provider's key window passes)`);
      return "sent";
    }
  }
}
