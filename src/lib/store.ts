import { createClient } from "@supabase/supabase-js";
import type { Classification, StoredPost, ThemeCount, ThemeTrend, Topic } from "./types";
import type { EvidencePost, PriorWeek } from "./analysis";
import type { Checkpoint } from "./checkpoints";
import { shiftWeek } from "./analysis";
import type { ConfigSnapshot, WatchConfig, WatchTerm } from "./watchlist";
import type { Comparison, Coverage } from "./coverage";
import type { BriefDraft, BriefRecord } from "./brief-policy";
import type { Diagnostic } from "./diagnostics";
import { sanitizeError } from "./text";

export type RunStatus = "running" | "succeeded" | "partial" | "failed";
export type EmailOutcome = "sent" | "skipped" | "failed" | "already_sent" | "in_progress" | "unconfirmed" | "not_attempted";
export type EmailClaim = "claimed" | "already_sent" | "in_progress" | "unconfirmed" | "no_brief";

export interface RunStart { week_start: string; period_start: Date; period_end: Date; trigger: "scheduled" | "backfill" }
export interface ClassificationFailure { id: string; code: string }
export interface RunFinish {
  status: RunStatus;
  fetched_total?: number;
  new_posts?: number;
  classified_ok?: number;
  classification_failed?: number;
  used_fallback?: boolean;
  email_status?: EmailOutcome;
  warnings?: string[];
  /** Structured diagnostics. When present they are what is stored (in the same jsonb column); plain warnings remain the fallback. */
  diagnostics?: Diagnostic[];
  /** The effective watchlist and sensitivity the run used, for reproducibility. */
  config_snapshot?: ConfigSnapshot;
  error?: string | null;
}
export interface SourceFetchRow {
  topic_id: string;
  source: string;
  status: "ok" | "partial" | "error";
  requests: number;
  failed_requests: number;
  fetched: number; // records the source returned
  accepted: number; // records that passed the window and keyword checks
  inserted: number; // records that were new to the database
  truncated: boolean;
  error: string | null;
  duration_ms: number;
}
export interface ReportPeriodRow {
  week_start: string;
  period_start: string; // ISO
  period_end: string; // ISO
  coverage: { sources: Coverage; comparison?: Comparison };
}

/** Deterministic order for everything that depends on topic order (assignment of overlapping matches). */
export function orderTopics<T extends { id: string; created_at?: string }>(topics: T[]): T[] {
  return [...topics].sort((a, b) =>
    (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id));
}

export interface Store {
  getActiveTopics(): Promise<Topic[]>;
  getExistingKeys(posts: { source: string; source_id: string }[]): Promise<Set<string>>;
  insertPosts(posts: Omit<StoredPost, "id" | "theme" | "sentiment" | "unresolved">[]): Promise<void>;
  getUnclassifiedPosts(from: Date, to: Date): Promise<StoredPost[]>;
  /** The watchlist (terms, exclusions, sensitivity). Empty terms mean "use each topic's legacy keywords". */
  getWatchConfig(): Promise<WatchConfig>;
  /** Classified, relevant posts in a period with the evidence fields the weekly analysis needs. */
  getEvidencePosts(from: Date, to: Date): Promise<EvidencePost[]>;
  /** Records WHY posts could not be classified (a short stable code each). Best-effort. */
  saveClassificationFailures(items: ClassificationFailure[]): Promise<void>;
  /** Per (source, topic) collection checkpoints: last attempt, last success and the committed range. */
  getCheckpoints(): Promise<Checkpoint[]>;
  saveCheckpoints(rows: Checkpoint[]): Promise<void>;
  /** Up to `count` immediately preceding weekly reports (counts and coverage), for the baseline and persistence. Legacy weeks are not included. */
  getPriorWeeks(weekStart: string, count: number): Promise<PriorWeek[]>;
  saveClassifications(items: Classification[]): Promise<void>;
  getClassifiedPosts(from: Date, to: Date): Promise<Pick<StoredPost, "topic_id" | "theme" | "unresolved">[]>;
  getSourceCounts(from: Date, to: Date): Promise<Record<string, number>>;
  getAggregates(weekStart: string): Promise<ThemeCount[]>;
  saveAggregates(weekStart: string, rows: ThemeCount[]): Promise<void>;
  getReportPeriod(weekStart: string): Promise<ReportPeriodRow | null>;
  saveReportPeriod(row: ReportPeriodRow): Promise<void>;
  /** Report periods that began on or after `since`, newest first. */
  listReportPeriods(since: Date): Promise<ReportPeriodRow[]>;
  /** The saved report for a period (the one version both the dashboard and the email use). */
  getBrief(weekStart: string): Promise<BriefRecord | null>;
  /**
   * Compare-and-set save. `expectVersion` null means "create"; otherwise the write only applies if the stored
   * version still equals it and the report has not been (or started to be) delivered. Returns saved=false when
   * someone else got there first, in which case the caller must use what is stored.
   */
  saveBrief(weekStart: string, draft: BriefDraft, expectVersion: number | null): Promise<{ saved: boolean; version: number }>;

  // observability (best-effort: callers must not let these hide a pipeline error)
  startRun(info: RunStart): Promise<string>;
  recordSourceFetches(runId: string, rows: SourceFetchRow[]): Promise<void>;
  finishRun(runId: string, patch: RunFinish): Promise<void>;
  /** Is another run for this reporting period still in progress (started recently and not finished)? Guards against a duplicated or overlapping trigger. */
  hasActiveRun(weekStart: string, withinMs: number): Promise<boolean>;

  // email-once guard (atomic per reporting week)
  claimEmail(weekStart: string): Promise<EmailClaim>;
  markEmailSent(weekStart: string, version: number, messageId?: string | null): Promise<void>;
  markEmailFailed(weekStart: string, error: string): Promise<void>;
  releaseEmailClaim(weekStart: string): Promise<void>;
}

/** A claim that is still "sending" after this long is treated as abandoned (crashed run) and may be retaken. */
export const EMAIL_LEASE_MS = 15 * 60_000;
/**
 * Resend remembers an idempotency key for 24 h. A claim left in "sending" (crash, or a send whose outcome is unknown) may be
 * retried automatically only while the same key is still remembered, so a retry cannot duplicate. Margin: 1 h.
 * Past this age the outcome can no longer be checked, so the claim is NOT retaken: the week is reported "unconfirmed"
 * and a person decides (see BACKEND.md, "Unconfirmed delivery").
 */
export const EMAIL_KEY_SAFE_MS = 23 * 3_600_000;

export function supabaseFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  return createClient(url, key, { auth: { persistSession: false } });
}

type Db = ReturnType<typeof supabaseFromEnv>;
const PAGE = 1000;
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

function ok<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`supabase ${what}: ${res.error.message}`);
  return res.data as T;
}

async function paged<T>(run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string) {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = ok(await run(from, from + PAGE - 1), what);
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

export function makeSupabaseStore(db: Db = supabaseFromEnv()): Store {
  return {
    async getActiveTopics() {
      const rows = ok(
        await db.from("topics").select("*").eq("active", true).order("created_at", { ascending: true }).order("id", { ascending: true }),
        "topics",
      );
      return orderTopics(rows as Topic[]); // ordered in SQL and again here, so the order never depends on the driver
    },

    async getExistingKeys(posts) {
      const keys = new Set<string>();
      for (const source of new Set(posts.map((p) => p.source))) {
        const ids = posts.filter((p) => p.source === source).map((p) => p.source_id);
        for (const part of chunk(ids, 200)) {
          const rows = ok(await db.from("raw_posts").select("source_id").eq("source", source).in("source_id", part), "existing keys");
          rows.forEach((r: { source_id: string }) => keys.add(`${source}:${r.source_id}`));
        }
      }
      return keys;
    },

    async insertPosts(posts) {
      for (const part of chunk(posts, 200)) {
        // ignoreDuplicates makes a concurrent/repeated run harmless even if the pre-check raced
        ok(await db.from("raw_posts").upsert(part, { onConflict: "source,source_id", ignoreDuplicates: true }), "insert posts");
      }
    },

    async getUnclassifiedPosts(from, to) {
      return paged<StoredPost>(
        (a, b) => db.from("raw_posts").select("*").is("theme", null)
          .gte("posted_at", from.toISOString()).lt("posted_at", to.toISOString()).order("posted_at").order("id").range(a, b),
        "unclassified posts",
      );
    },

    async saveClassifications(items) {
      const now = new Date().toISOString();
      for (const part of chunk(items, 25)) {
        await Promise.all(part.map(async (c) =>
          ok(await db.from("raw_posts").update({
            theme: c.theme, sentiment: c.sentiment, unresolved: c.unresolved, classified_at: now,
            ...(c.relevant !== undefined ? { relevant: c.relevant } : {}),
            ...(c.confidence !== undefined ? { confidence: c.confidence } : {}),
            ...(c.problem !== undefined ? { problem: c.problem } : {}),
            ...(c.excerpt !== undefined ? { excerpt: c.excerpt } : {}),
            ...(c.post_kind !== undefined ? { post_kind: c.post_kind } : {}),
            ...(c.resolution !== undefined ? { resolution: c.resolution } : {}),
            ...(c.flags !== undefined ? { flags: c.flags } : {}),
            ...(c.classification_version !== undefined ? { classification_version: c.classification_version } : {}),
            classification_error: null,
          }).eq("id", c.id).is("theme", null), "save classification"))); // never overwrite a stored result
      }
    },

    async getWatchConfig() {
      // Both tables are new; if they do not exist yet the pipeline simply uses each topic's legacy keywords (balanced).
      const s = await db.from("watchlist_settings").select("sensitivity").eq("id", 1).maybeSingle();
      const t = await db.from("watch_terms").select("id, topic_id, term, kind, status, applies_to").order("topic_id").order("kind").order("term");
      if (t.error || s.error) return { sensitivity: "balanced", terms: [] };
      const sensitivity = (s.data as { sensitivity?: string } | null)?.sensitivity;
      return { sensitivity: sensitivity === "strict" || sensitivity === "early" ? sensitivity : "balanced", terms: (t.data ?? []) as WatchTerm[] };
    },

    async getEvidencePosts(from, to) {
      const rows = await paged<Record<string, unknown>>(
        (a, b) => db.from("raw_posts")
          .select("id, source, topic_id, theme, title, url, author, posted_at, confidence, excerpt, resolution, unresolved, flags")
          .not("theme", "is", null).or("relevant.is.null,relevant.eq.true")
          .gte("posted_at", from.toISOString()).lt("posted_at", to.toISOString()).order("posted_at").order("id").range(a, b),
        "evidence posts",
      );
      return rows.map((r) => ({ ...r, flags: (r.flags as string[] | null) ?? [] })) as unknown as EvidencePost[];
    },

    async saveClassificationFailures(items) {
      for (const part of chunk(items, 50)) {
        await Promise.all(part.map(async (f) =>
          ok(await db.from("raw_posts").update({ classification_error: f.code.slice(0, 40) }).eq("id", f.id).is("theme", null), "save classification failure")));
      }
    },

    async getCheckpoints() {
      const res = await db.from("source_checkpoints").select("source, topic_id, last_attempt_at, last_success_at, covered_from, committed_through, last_status");
      return res.error ? [] : ((res.data ?? []) as Checkpoint[]);
    },

    async saveCheckpoints(rows) {
      if (!rows.length) return;
      ok(await db.from("source_checkpoints").upsert(rows, { onConflict: "source,topic_id" }), "save checkpoints");
    },

    async getPriorWeeks(weekStart, count) {
      const keys = Array.from({ length: count }, (_, i) => shiftWeek(weekStart, -(i + 1)));
      const periods = ok(await db.from("report_periods").select("week_start, coverage").in("week_start", keys), "prior report periods") as unknown as { week_start: string; coverage: { sources?: Coverage } | null }[];
      const aggs = ok(await db.from("weekly_aggregates").select("week_start, topic_id, theme, mention_count, unresolved_count").in("week_start", keys), "prior aggregates") as unknown as { week_start: string; topic_id: string; theme: string; mention_count: number; unresolved_count: number }[];
      return keys.flatMap((k): PriorWeek[] => {
        const p = periods.find((x) => x.week_start === k);
        if (!p) return []; // not recorded under the IST period convention (or missing): not usable
        return [{ weekStart: k, coverage: p.coverage?.sources ?? null, counts: aggs.filter((a) => a.week_start === k).map((a) => ({ topic_id: a.topic_id, theme: a.theme, count: a.mention_count, unresolved: a.unresolved_count })) }];
      });
    },

    async getClassifiedPosts(from, to) {
      return paged(
        (a, b) => db.from("raw_posts").select("topic_id, theme, unresolved").not("theme", "is", null)
          .gte("posted_at", from.toISOString()).lt("posted_at", to.toISOString()).order("posted_at").order("id").range(a, b),
        "classified posts",
      ) as Promise<Pick<StoredPost, "topic_id" | "theme" | "unresolved">[]>;
    },

    async getSourceCounts(from, to) {
      const rows = await paged<{ source: string }>(
        (a, b) => db.from("raw_posts").select("source")
          .gte("posted_at", from.toISOString()).lt("posted_at", to.toISOString()).order("posted_at").order("id").range(a, b),
        "source counts",
      );
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.source] = (counts[r.source] ?? 0) + 1;
      return counts;
    },

    async getReportPeriod(weekStart) {
      const row = ok(await db.from("report_periods").select("week_start, period_start, period_end, coverage").eq("week_start", weekStart).maybeSingle(), "report period");
      return row as ReportPeriodRow | null;
    },

    async listReportPeriods(since) {
      const rows = ok(
        await db.from("report_periods").select("week_start, period_start, period_end, coverage")
          .gte("period_start", since.toISOString()).order("period_start", { ascending: false }),
        "list report periods",
      );
      return rows as ReportPeriodRow[];
    },

    async saveReportPeriod(row) {
      ok(await db.from("report_periods").upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "week_start" }), "save report period");
    },

    async getAggregates(weekStart) {
      const rows = ok(await db.from("weekly_aggregates").select("topic_id, theme, mention_count, unresolved_count").eq("week_start", weekStart), "aggregates");
      return rows.map((r: { topic_id: string; theme: string; mention_count: number; unresolved_count: number }) => ({
        topic_id: r.topic_id, theme: r.theme, count: r.mention_count, unresolved: r.unresolved_count,
      }));
    },

    async saveAggregates(weekStart, rows) {
      if (!rows.length) return;
      ok(await db.from("weekly_aggregates").upsert(
        rows.map((r) => ({ week_start: weekStart, topic_id: r.topic_id, theme: r.theme, mention_count: r.count, unresolved_count: r.unresolved })),
        { onConflict: "week_start,topic_id,theme" },
      ), "save aggregates");
    },

    async getBrief(weekStart) {
      const row = ok(
        await db.from("briefs")
          .select("week_start, narrative, top_pain_points, coverage, version, pending_count, used_fallback, email_status, emailed_version, created_at, config_snapshot, analysis")
          .eq("week_start", weekStart).maybeSingle(),
        "get brief",
      ) as unknown as {
        week_start: string; narrative: string; top_pain_points: ThemeTrend[]; coverage: BriefDraft["coverage"] | null; version: number;
        pending_count: number; used_fallback: boolean; email_status: BriefRecord["emailStatus"]; emailed_version: number | null; created_at: string;
        config_snapshot: BriefDraft["configSnapshot"]; analysis: BriefDraft["analysis"];
      } | null;
      if (!row) return null;
      return {
        week_start: row.week_start,
        narrative: row.narrative,
        points: row.top_pain_points,
        coverage: row.coverage ?? { sources: {}, comparison: { state: "no_prior", reasons: [] } },
        pendingCount: row.pending_count,
        usedFallback: row.used_fallback,
        version: row.version,
        emailStatus: row.email_status,
        emailedVersion: row.emailed_version,
        createdAt: row.created_at,
        configSnapshot: row.config_snapshot ?? null,
        analysis: row.analysis ?? null,
      };
    },

    // Create: INSERT ... ON CONFLICT DO NOTHING, so a concurrent creator simply loses.
    // Replace: UPDATE ... WHERE version = <expected> AND email_status IS NULL OR 'failed'. Postgres re-checks that
    // predicate under the row lock, so a write based on a stale read, or racing a delivery, matches zero rows.
    // The email_* columns are never part of this write, so delivery metadata is preserved.
    async saveBrief(weekStart, draft, expectVersion) {
      const content = {
        narrative: draft.narrative,
        top_pain_points: draft.points,
        coverage: draft.coverage,
        pending_count: draft.pendingCount,
        used_fallback: draft.usedFallback,
        config_snapshot: draft.configSnapshot ?? null,
        analysis: draft.analysis ?? null,
      };
      if (expectVersion === null) {
        const rows = ok(
          await db.from("briefs").upsert({ week_start: weekStart, ...content, version: 1 }, { onConflict: "week_start", ignoreDuplicates: true }).select("version"),
          "create brief",
        ) as unknown as { version: number }[];
        return rows.length ? { saved: true, version: 1 } : { saved: false, version: 0 };
      }
      const rows = ok(
        await db.from("briefs")
          .update({ ...content, version: expectVersion + 1, created_at: new Date().toISOString() })
          .eq("week_start", weekStart)
          .eq("version", expectVersion)
          .or("email_status.is.null,email_status.eq.failed")
          .select("version"),
        "replace brief",
      ) as unknown as { version: number }[];
      return rows.length ? { saved: true, version: expectVersion + 1 } : { saved: false, version: expectVersion };
    },

    async startRun(info) {
      const row = ok(await db.from("pipeline_runs").insert({
        week_start: info.week_start,
        period_start: info.period_start.toISOString(),
        period_end: info.period_end.toISOString(),
        trigger: info.trigger,
      }).select("id").single(), "start run");
      return (row as unknown as { id: string }).id;
    },

    async recordSourceFetches(runId, rows) {
      if (!rows.length) return;
      ok(await db.from("source_fetches").insert(rows.map((r) => ({ ...r, run_id: runId }))), "record source fetches");
    },

    async hasActiveRun(weekStart, withinMs) {
      const since = new Date(Date.now() - withinMs).toISOString();
      const rows = ok(await db.from("pipeline_runs").select("id").eq("week_start", weekStart).eq("status", "running").gte("started_at", since).limit(1), "active run check") as unknown[];
      return rows.length > 0;
    },

    async finishRun(runId, patch) {
      const { diagnostics, warnings, ...rest } = patch;
      ok(await db.from("pipeline_runs").update({
        ...rest,
        warnings: diagnostics && diagnostics.length ? diagnostics : (warnings ?? []),
        error: patch.error ? sanitizeError(patch.error, 500) : null,
        finished_at: new Date().toISOString(),
      }).eq("id", runId), "finish run");
    },

    // Atomic claim: a single conditional UPDATE. Postgres re-checks the predicate under the row lock, so of two
    // overlapping requests exactly one sees a claimable row; the other gets zero rows back. Rows already "sent"
    // never match, and a "sending" row only matches once its lease has expired.
    async claimEmail(weekStart) {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - EMAIL_LEASE_MS).toISOString();
      const keyExpired = new Date(now.getTime() - EMAIL_KEY_SAFE_MS).toISOString();
      const claimed = ok(await db.from("briefs")
        .update({ email_status: "sending", email_claimed_at: now.toISOString(), email_error: null })
        .eq("week_start", weekStart)
        .or(`email_status.is.null,email_status.eq.failed,and(email_status.eq.sending,email_claimed_at.lt.${staleBefore},email_claimed_at.gt.${keyExpired})`)
        .select("week_start"), "claim email") as unknown[];
      if (claimed.length) return "claimed";
      const row = ok(await db.from("briefs").select("email_status, email_claimed_at").eq("week_start", weekStart).maybeSingle(), "read email status") as { email_status: string | null; email_claimed_at: string | null } | null;
      if (!row) return "no_brief";
      if (row.email_status === "sent") return "already_sent";
      const claimedAt = row.email_claimed_at ? new Date(row.email_claimed_at).getTime() : null;
      if (row.email_status === "sending" && (claimedAt === null || claimedAt <= now.getTime() - EMAIL_KEY_SAFE_MS)) return "unconfirmed";
      return "in_progress";
    },

    // These transitions apply only while the row is still "sending". There is no per-claimant token: that is safe only
    // because the lease (15 min) is far longer than the longest possible function run (300 s), so a live holder
    // cannot still be running when its claim is reclaimed.
    async markEmailSent(weekStart, version, messageId) {
      const rows = ok(await db.from("briefs").update({ email_status: "sent", email_sent_at: new Date().toISOString(), email_error: null, emailed_version: version, email_message_id: messageId ?? null })
        .eq("week_start", weekStart).eq("email_status", "sending").select("week_start"), "mark email sent") as unknown[];
      // Matching no row means the claim is not ours any more: that must not look like success.
      if (!rows.length) throw new Error("mark email sent: no row in 'sending' state matched");
    },

    async markEmailFailed(weekStart, error) {
      ok(await db.from("briefs").update({ email_status: "failed", email_error: sanitizeError(error, 300) })
        .eq("week_start", weekStart).eq("email_status", "sending"), "mark email failed");
    },

    async releaseEmailClaim(weekStart) {
      ok(await db.from("briefs").update({ email_status: null, email_claimed_at: null })
        .eq("week_start", weekStart).eq("email_status", "sending"), "release email claim");
    },
  };
}
