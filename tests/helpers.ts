import type { BriefDraft, BriefRecord } from "@/lib/brief-policy";
import { EMAIL_KEY_SAFE_MS, EMAIL_LEASE_MS, type EmailClaim, type ReportPeriodRow, type RunFinish, type RunStart, type SourceFetchRow, type Store } from "@/lib/store";
import type { Classification, FetchedPost, StoredPost, ThemeCount, ThemeTrend, Topic } from "@/lib/types";

export const TOPIC: Topic = {
  id: "t1", name: "Code review", keywords: ["code review", "false positive"],
  canonical_themes: ["False positives", "Slow reviews"], tags: [], category: null, active: true,
};

export const post = (over: Partial<FetchedPost> = {}): FetchedPost => ({
  source: "hn", source_id: "1", topic_id: "t1", title: "code review is painful", body: "",
  url: null, author: null, posted_at: "2026-10-08T10:00:00Z", is_answered: null, ...over,
});

type EmailState = { status: "sending" | "sent" | "failed" | null; claimedAt: number | null; error?: string; emailedVersion?: number | null; messageId?: string | null };
type StoredBrief = BriefDraft & { version: number; createdAt: string };

/**
 * In-memory Store for tests. Email claims reproduce the SQL guard's semantics (a claim only succeeds on a
 * null/failed row or an expired lease) and, being synchronous, are atomic like the single conditional UPDATE.
 * `fail` injects a failure into any method by name.
 */
export class MemoryStore implements Store {
  posts: StoredPost[] = [];
  aggregates = new Map<string, ThemeCount[]>();
  briefs = new Map<string, StoredBrief>();
  reports = new Map<string, ReportPeriodRow>();
  emails = new Map<string, EmailState>();
  runs: (RunStart & { id: string; startedAt?: number; finish?: RunFinish })[] = [];
  sourceFetches: (SourceFetchRow & { run_id: string })[] = [];
  fail: Partial<Record<keyof Store, Error>> = {};
  saves: number[] = []; // size of each saveClassifications call, in order
  constructor(public topics: Topic[] = [TOPIC]) {}

  /** Transient faults: the next N calls of a method throw, then it works again. */
  failTimes: Partial<Record<keyof Store, number>> = {};
  private boom(name: keyof Store) {
    if (this.fail[name]) throw this.fail[name];
    const n = this.failTimes[name] ?? 0;
    if (n > 0) { this.failTimes[name] = n - 1; throw new Error(`transient ${String(name)} failure`); }
  }

  async getActiveTopics() { this.boom("getActiveTopics"); return this.topics.filter((t) => t.active); }
  async getExistingKeys() { return new Set(this.posts.map((p) => `${p.source}:${p.source_id}`)); }
  async insertPosts(posts: FetchedPost[]) {
    this.boom("insertPosts");
    for (const p of posts) {
      if (this.posts.some((x) => x.source === p.source && x.source_id === p.source_id)) continue;
      this.posts.push({ ...p, id: `id-${this.posts.length}`, theme: null, sentiment: null, unresolved: null });
    }
  }
  private inRange(p: StoredPost, from: Date, to: Date) { const t = new Date(p.posted_at).getTime(); return t >= from.getTime() && t < to.getTime(); }
  async getUnclassifiedPosts(from: Date, to: Date) { return this.posts.filter((p) => p.theme === null && this.inRange(p, from, to)); }
  async saveClassifications(items: Classification[]) {
    this.boom("saveClassifications");
    this.saves.push(items.length);
    for (const c of items) {
      const row = this.posts.find((p) => p.id === c.id)!;
      if (row.theme === null) Object.assign(row, c, { id: c.id }); // never overwrite a stored result
    }
  }
  async getClassifiedPosts(from: Date, to: Date) { return this.posts.filter((p) => p.theme !== null && this.inRange(p, from, to)); }
  async getSourceCounts(from: Date, to: Date) {
    const out: Record<string, number> = {};
    for (const p of this.posts) if (this.inRange(p, from, to)) out[p.source] = (out[p.source] ?? 0) + 1;
    return out;
  }
  async getAggregates(week: string) { return this.aggregates.get(week) ?? []; }
  async saveAggregates(week: string, rows: ThemeCount[]) { this.aggregates.set(week, rows); }
  async getReportPeriod(week: string) { return this.reports.get(week) ?? null; }
  async saveReportPeriod(row: ReportPeriodRow) { this.boom("saveReportPeriod"); this.reports.set(row.week_start, row); }
  async getBrief(week: string): Promise<BriefRecord | null> {
    this.boom("getBrief");
    const b = this.briefs.get(week);
    if (!b) return null;
    const e = this.emails.get(week);
    return { ...b, week_start: week, emailStatus: e?.status ?? null, emailedVersion: e?.emailedVersion ?? null };
  }
  /** Compare-and-set, as in the SQL: create only if absent; replace only at the expected version and while undelivered. */
  async saveBrief(week: string, draft: BriefDraft, expectVersion: number | null) {
    this.boom("saveBrief");
    const cur = this.briefs.get(week);
    if (expectVersion === null) {
      if (cur) return { saved: false, version: 0 };
      this.briefs.set(week, { ...draft, version: 1, createdAt: new Date().toISOString() });
      return { saved: true, version: 1 };
    }
    const status = this.emails.get(week)?.status ?? null;
    if (!cur || cur.version !== expectVersion || status === "sent" || status === "sending") return { saved: false, version: expectVersion };
    this.briefs.set(week, { ...draft, version: expectVersion + 1, createdAt: new Date().toISOString() });
    return { saved: true, version: expectVersion + 1 };
  }
  async listReportPeriods(since: Date) {
    return [...this.reports.values()].filter((r) => new Date(r.period_start).getTime() >= since.getTime())
      .sort((a, b) => b.period_start.localeCompare(a.period_start));
  }

  async startRun(info: RunStart) { this.boom("startRun"); const id = `run-${this.runs.length + 1}`; this.runs.push({ ...info, id, startedAt: Date.now() }); return id; }
  async hasActiveRun(week: string, withinMs: number) { this.boom("hasActiveRun"); return this.runs.some((r) => r.week_start === week && !r.finish && Date.now() - (r.startedAt ?? 0) <= withinMs); }
  async recordSourceFetches(runId: string, rows: SourceFetchRow[]) { this.boom("recordSourceFetches"); this.sourceFetches.push(...rows.map((r) => ({ ...r, run_id: runId }))); }
  async finishRun(runId: string, patch: RunFinish) { this.boom("finishRun"); this.runs.find((r) => r.id === runId)!.finish = patch; }

  async claimEmail(week: string): Promise<EmailClaim> {
    this.boom("claimEmail");
    if (!this.briefs.has(week)) return "no_brief";
    const s = this.emails.get(week) ?? { status: null, claimedAt: null };
    const age = s.claimedAt === null ? Infinity : Date.now() - s.claimedAt;
    const stale = s.status === "sending" && age > EMAIL_LEASE_MS && age < EMAIL_KEY_SAFE_MS;
    if (s.status === null || s.status === "failed" || stale) {
      this.emails.set(week, { status: "sending", claimedAt: Date.now(), emailedVersion: s.emailedVersion ?? null });
      return "claimed";
    }
    if (s.status === "sent") return "already_sent";
    return s.status === "sending" && age >= EMAIL_KEY_SAFE_MS ? "unconfirmed" : "in_progress";
  }
  async markEmailSent(week: string, version: number, messageId?: string | null) {
    this.boom("markEmailSent");
    const s = this.emails.get(week);
    if (s?.status === "sending") this.emails.set(week, { status: "sent", claimedAt: s.claimedAt, emailedVersion: version, messageId: messageId ?? null });
  }
  async markEmailFailed(week: string, error: string) { this.boom("markEmailFailed"); const s = this.emails.get(week); if (s?.status === "sending") this.emails.set(week, { status: "failed", claimedAt: s.claimedAt, error }); }
  async releaseEmailClaim(week: string) { const s = this.emails.get(week); if (s?.status === "sending") this.emails.set(week, { status: null, claimedAt: null }); }
}

/** Seeds a previous report recorded under the IST convention so it counts as a valid baseline. */
export function seedPreviousReport(
  store: MemoryStore,
  opts: { weekStart: string; periodStart: string; rows: ThemeCount[]; sources: Record<string, { status: "ok" | "partial" | "error"; posts: number }> },
) {
  const start = new Date(opts.periodStart);
  store.aggregates.set(opts.weekStart, opts.rows);
  store.reports.set(opts.weekStart, {
    week_start: opts.weekStart,
    period_start: start.toISOString(),
    period_end: new Date(start.getTime() + 7 * 86_400_000).toISOString(),
    coverage: { sources: opts.sources as never },
  });
}
