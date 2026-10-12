import { supabaseFromEnv } from "./store";
import type { Sensitivity, TermKind, TermStatus, WatchTerm } from "./watchlist";

/* Persistence for everything the team touches: watchlist edits, review items, votes, decisions, packs, alerts and sign-in tokens. */

export const REVIEW_STATES = ["under_review", "open_for_votes", "prioritised", "parked", "rejected", "already_addressed"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export const OUTCOMES = ["prioritised", "parked", "rejected", "already_addressed"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const CHOICES = ["prioritise", "park"] as const;
export type Choice = (typeof CHOICES)[number];

export interface ReviewItem { id: string; topic_id: string; theme: string; state: ReviewState; reason: string | null; first_week: string | null; created_by: string; created_at: string; updated_at: string }
export interface Vote { item_id: string; voter: string; choice: Choice; updated_at: string }
export interface Decision { id: number; item_id: string; outcome: Outcome; decided_by: string; decided_at: string; rationale: string; evidence: unknown; vote_snapshot: VoteTally | null; followup: boolean; superseded_at: string | null }
export interface VoteTally { prioritise: number; park: number; total: number }
export interface ReviewEvent { id: number; at: string; item_id: string | null; actor: string; action: string; detail: unknown }
export interface WatchChange { id: number; at: string; actor: string; action: string; subject: string; before: unknown; after: unknown }
export interface PackRow { id: string; created_at: string; created_by: string; week_start: string | null; content: unknown; decisions_digest: string }

export interface TeamStore {
  // watchlist
  getTerms(): Promise<WatchTerm[]>;
  addTerm(t: { topic_id: string; term: string; kind: TermKind; applies_to: string | null }): Promise<WatchTerm>;
  updateTerm(id: string, patch: { term?: string; status?: TermStatus }): Promise<WatchTerm | null>;
  removeTerm(id: string): Promise<boolean>;
  getSensitivity(): Promise<Sensitivity>;
  setSensitivity(s: Sensitivity, by: string): Promise<void>;
  logChange(c: { actor: string; action: string; subject: string; before?: unknown; after?: unknown }): Promise<void>;
  getChanges(limit: number): Promise<WatchChange[]>;
  /** Matched-term arrays of posts in a window, for term productivity. */
  getMatchedTerms(from: Date, to: Date): Promise<{ topic_id: string; matched_terms: string[] | null }[]>;

  // review
  listItems(): Promise<ReviewItem[]>;
  getItem(id: string): Promise<ReviewItem | null>;
  /** Creates the item, or returns the existing one for the same (topic, theme): never a duplicate. */
  createItem(i: { topic_id: string; theme: string; reason: string; first_week: string | null; created_by: string }): Promise<{ item: ReviewItem; created: boolean }>;
  setState(id: string, state: ReviewState): Promise<ReviewItem | null>;
  listVotes(itemId?: string): Promise<Vote[]>;
  upsertVote(itemId: string, voter: string, choice: Choice): Promise<void>;
  deleteVote(itemId: string, voter: string): Promise<boolean>;
  listDecisions(itemId?: string): Promise<Decision[]>;
  /** Atomically supersedes the current decision, records this one and moves the item to the matching state. */
  recordDecision(d: { item_id: string; outcome: Outcome; decided_by: string; rationale: string; evidence: unknown; vote_snapshot: VoteTally; followup: boolean }): Promise<number>;
  addEvent(e: { item_id: string | null; actor: string; action: string; detail?: unknown }): Promise<void>;
  listEvents(itemId: string, limit: number): Promise<ReviewEvent[]>;

  // packs
  savePack(p: { created_by: string; week_start: string | null; content: unknown; decisions_digest: string }): Promise<PackRow>;
  latestPack(): Promise<PackRow | null>;

  // alerts
  /** true when this key was newly claimed, false when it already existed (a duplicate). */
  claimAlert(key: string, kind: string, runId: string | null): Promise<boolean>;
  releaseAlert(key: string): Promise<void>;
  countAlerts(kind: string, since: Date): Promise<number>;

  // sign-in
  createToken(nonce: string, email: string, expiresAt: Date): Promise<void>;
  /** Marks the link used exactly once. Returns the email on success, null when unknown, expired or already used. */
  consumeToken(nonce: string, now: Date): Promise<string | null>;
  countTokens(email: string, since: Date): Promise<number>;
}

type Db = ReturnType<typeof supabaseFromEnv>;
function ok<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`supabase ${what}: ${res.error.message}`);
  return res.data as T;
}
const UNIQUE = "23505";

export function makeSupabaseTeamStore(db: Db = supabaseFromEnv()): TeamStore {
  return {
    async getTerms() {
      return ok(await db.from("watch_terms").select("id, topic_id, term, kind, status, applies_to").order("topic_id").order("kind").order("term"), "terms") as WatchTerm[];
    },
    async addTerm(t) {
      const res = await db.from("watch_terms").insert(t).select("id, topic_id, term, kind, status, applies_to").single();
      if (res.error?.code === UNIQUE) throw new Error("That term already exists on this topic.");
      return ok(res, "add term") as WatchTerm;
    },
    async updateTerm(id, patch) {
      const res = await db.from("watch_terms").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("id, topic_id, term, kind, status, applies_to").maybeSingle();
      if (res.error?.code === UNIQUE) throw new Error("That term already exists on this topic.");
      return ok(res, "update term") as WatchTerm | null;
    },
    async removeTerm(id) {
      return (ok(await db.from("watch_terms").delete().eq("id", id).select("id"), "remove term") as unknown[]).length > 0;
    },
    async getSensitivity() {
      const r = ok(await db.from("watchlist_settings").select("sensitivity").eq("id", 1).maybeSingle(), "sensitivity") as { sensitivity?: string } | null;
      return r?.sensitivity === "strict" || r?.sensitivity === "early" ? r.sensitivity : "balanced";
    },
    async setSensitivity(s, by) {
      ok(await db.from("watchlist_settings").upsert({ id: 1, sensitivity: s, updated_at: new Date().toISOString(), updated_by: by }), "set sensitivity");
    },
    async logChange(c) {
      ok(await db.from("watchlist_changes").insert({ actor: c.actor, action: c.action, subject: c.subject, before: c.before ?? null, after: c.after ?? null }), "log change");
    },
    async getChanges(limit) {
      return ok(await db.from("watchlist_changes").select("*").order("at", { ascending: false }).order("id", { ascending: false }).limit(limit), "changes") as WatchChange[];
    },
    async getMatchedTerms(from, to) {
      const out: { topic_id: string; matched_terms: string[] | null }[] = [];
      for (let a = 0; ; a += 1000) {
        const rows = ok(await db.from("raw_posts").select("topic_id, matched_terms").gte("posted_at", from.toISOString()).lt("posted_at", to.toISOString()).order("posted_at").order("id").range(a, a + 999), "matched terms") as typeof out;
        out.push(...rows);
        if (rows.length < 1000) return out;
      }
    },

    async listItems() {
      return ok(await db.from("review_items").select("*").order("created_at", { ascending: false }).order("id"), "review items") as ReviewItem[];
    },
    async getItem(id) {
      return ok(await db.from("review_items").select("*").eq("id", id).maybeSingle(), "review item") as ReviewItem | null;
    },
    async createItem(i) {
      const ins = await db.from("review_items").insert(i).select("*").single();
      if (!ins.error) return { item: ins.data as ReviewItem, created: true };
      if (ins.error.code !== UNIQUE) throw new Error(`supabase create review item: ${ins.error.message}`);
      const ex = ok(await db.from("review_items").select("*").eq("topic_id", i.topic_id).eq("theme", i.theme).single(), "existing review item") as ReviewItem;
      return { item: ex, created: false };
    },
    async setState(id, state) {
      return ok(await db.from("review_items").update({ state, updated_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle(), "set state") as ReviewItem | null;
    },
    async listVotes(itemId) {
      const q = db.from("review_votes").select("*");
      return ok(await (itemId ? q.eq("item_id", itemId) : q), "votes") as Vote[];
    },
    async upsertVote(itemId, voter, choice) {
      ok(await db.from("review_votes").upsert({ item_id: itemId, voter, choice, updated_at: new Date().toISOString() }, { onConflict: "item_id,voter" }), "vote");
    },
    async deleteVote(itemId, voter) {
      return (ok(await db.from("review_votes").delete().eq("item_id", itemId).eq("voter", voter).select("voter"), "withdraw vote") as unknown[]).length > 0;
    },
    async listDecisions(itemId) {
      const q = db.from("review_decisions").select("*");
      return ok(await (itemId ? q.eq("item_id", itemId) : q).order("decided_at", { ascending: false }).order("id", { ascending: false }), "decisions") as Decision[];
    },
    async recordDecision(d) {
      const id = ok(await db.rpc("record_review_decision", { p_item: d.item_id, p_outcome: d.outcome, p_by: d.decided_by, p_rationale: d.rationale, p_evidence: d.evidence ?? null, p_votes: d.vote_snapshot, p_followup: d.followup }), "record decision");
      return Number(id);
    },
    async addEvent(e) {
      ok(await db.from("review_events").insert({ item_id: e.item_id, actor: e.actor, action: e.action, detail: e.detail ?? null }), "event");
    },
    async listEvents(itemId, limit) {
      return ok(await db.from("review_events").select("*").eq("item_id", itemId).order("at", { ascending: false }).order("id", { ascending: false }).limit(limit), "events") as ReviewEvent[];
    },

    async savePack(p) {
      return ok(await db.from("sprint_packs").insert(p).select("*").single(), "save pack") as PackRow;
    },
    async latestPack() {
      return ok(await db.from("sprint_packs").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(), "latest pack") as PackRow | null;
    },

    async claimAlert(key, kind, runId) {
      const res = await db.from("alert_log").insert({ key, kind, run_id: runId });
      if (res.error?.code === UNIQUE) return false;
      ok(res, "claim alert");
      return true;
    },
    async releaseAlert(key) {
      ok(await db.from("alert_log").delete().eq("key", key), "release alert");
    },
    async countAlerts(kind, since) {
      const res = await db.from("alert_log").select("id", { count: "exact", head: true }).eq("kind", kind).gte("at", since.toISOString());
      if (res.error) throw new Error(`supabase count alerts: ${res.error.message}`);
      return res.count ?? 0;
    },

    async createToken(nonce, email, expiresAt) {
      ok(await db.from("auth_tokens").insert({ nonce, email, expires_at: expiresAt.toISOString() }), "create token");
    },
    async consumeToken(nonce, now) {
      // One conditional UPDATE: of two simultaneous uses only one can match "used_at is null".
      const rows = ok(await db.from("auth_tokens").update({ used_at: now.toISOString() }).eq("nonce", nonce).is("used_at", null).gt("expires_at", now.toISOString()).select("email"), "consume token") as { email: string }[];
      return rows[0]?.email ?? null;
    },
    async countTokens(email, since) {
      const res = await db.from("auth_tokens").select("nonce", { count: "exact", head: true }).eq("email", email).gte("created_at", since.toISOString());
      if (res.error) throw new Error(`supabase count tokens: ${res.error.message}`);
      return res.count ?? 0;
    },
  };
}
