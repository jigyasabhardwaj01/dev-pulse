import { matchAll } from "./matching";
import type { Topic } from "./types";

/*
 * The watchlist: what JARVIS monitors, what it deliberately ignores, and how strict it is about evidence. Everything here is
 * deterministic and pure so it can be tested exhaustively; persistence lives in watch-store.ts.
 */

export type Sensitivity = "strict" | "balanced" | "early";
export const SENSITIVITIES: Sensitivity[] = ["strict", "balanced", "early"];
export type TermKind = "include" | "exclude";
export type TermStatus = "active" | "paused";

export interface WatchTerm {
  id: string;
  topic_id: string;
  term: string;
  kind: TermKind;
  status: TermStatus;
  /** For an exclusion: the include term it is scoped to, or null for the whole topic. */
  applies_to: string | null;
}
export interface WatchConfig { sensitivity: Sensitivity; terms: WatchTerm[] }

export const MIN_TERM = 2;
export const MAX_TERM = 80;

// ---------------------------------------------------------------------------------------------------------------------------
export type NormalizeResult = { ok: true; term: string } | { ok: false; error: string };

/** Trim, collapse whitespace, lowercase, drop wrapping quotes. Rejects anything that could not be a sensible search phrase. */
export function normalizeTerm(raw: unknown): NormalizeResult {
  if (typeof raw !== "string") return { ok: false, error: "A term must be text." };
  // eslint-disable-next-line no-control-regex
  let t = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  t = t.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (t.length < MIN_TERM) return { ok: false, error: `A term needs at least ${MIN_TERM} characters.` };
  if (t.length > MAX_TERM) return { ok: false, error: `A term can have at most ${MAX_TERM} characters.` };
  if (!/[a-z0-9]/.test(t)) return { ok: false, error: "A term needs at least one letter or number." };
  if (!/^[a-z0-9][a-z0-9 +#./_-]*$/.test(t)) return { ok: false, error: "Use letters, numbers, spaces and + # . / _ - only." };
  return { ok: true, term: t };
}

/**
 * Terms that match plenty of non-developer text. They are NOT rejected: matches that rest only on such a term are flagged
 * and sent to classification (and, in strict mode, held to a higher bar). The list is deliberately explicit, not clever.
 */
export const AMBIGUOUS_TERMS = new Set([
  "ci", "cd", "pr", "prs", "bug", "bugs", "bot", "bots", "build", "builds", "test", "tests", "testing", "review", "reviews", "workflow", "workflows",
  "issue", "issues", "merge", "deploy", "release", "debug", "lint", "script", "scripts", "cache", "pipeline", "pipelines", "agile", "sprint", "ops",
  "tool", "tools", "code", "dev", "api", "app", "bot review", "false positive", "context switching", "productivity",
]);
export function ambiguityOf(term: string): string | null {
  if (AMBIGUOUS_TERMS.has(term)) return "This phrase is common outside developer discussion, so matches that rest only on it are flagged for classification.";
  if (!/\s/.test(term) && term.length <= 3) return "Very short single words match unrelated text.";
  return null;
}

export interface TermProblem { level: "error" | "warning"; message: string }

/** Everything that should stop, or merely warn about, adding `term` of `kind` to a topic. Pure: pass the topic's existing terms. */
export function checkTermChange(
  existing: WatchTerm[],
  candidate: { topic_id: string; term: string; kind: TermKind; applies_to?: string | null },
  ignoreId?: string,
): TermProblem[] {
  const out: TermProblem[] = [];
  const same = existing.filter((t) => t.topic_id === candidate.topic_id && t.id !== ignoreId);
  const scope = candidate.applies_to ?? null;
  if (same.some((t) => t.kind === candidate.kind && t.term === candidate.term && (t.applies_to ?? null) === scope)) {
    out.push({ level: "error", message: `"${candidate.term}" is already on this topic's ${candidate.kind === "include" ? "watchlist" : "exclusion list"}.` });
  }
  if (candidate.kind === "include") {
    if (same.some((t) => t.kind === "exclude" && t.term === candidate.term && t.applies_to === null)) {
      out.push({ level: "error", message: `"${candidate.term}" is an exclusion for this topic; remove that first.` });
    }
    const amb = ambiguityOf(candidate.term);
    if (amb) out.push({ level: "warning", message: amb });
  } else {
    const includes = same.filter((t) => t.kind === "include");
    const scoped = scope ? includes.find((t) => t.id === scope) : null;
    if (scope && !scoped) out.push({ level: "error", message: "An exclusion can only be scoped to one of this topic's own terms." });
    // an exclusion contained in an include term would remove ALL evidence for that term
    const swallowed = (scope ? (scoped ? [scoped] : []) : includes).filter((t) => matchAll(t.term, [candidate.term]).length > 0);
    for (const t of swallowed) out.push({ level: "error", message: `Excluding "${candidate.term}" would remove every match for "${t.term}". Scope it to a different term or choose a narrower phrase.` });
    if (!scope && !/\s/.test(candidate.term)) out.push({ level: "warning", message: `"${candidate.term}" is a single word applied to the whole topic, so it can hide unrelated discussions. A phrase, or a scope to one term, is safer.` });
    if (!scope && swallowed.length === 0) out.push({ level: "warning", message: "A topic-wide exclusion only removes a post when it matches the title or the post has no title match for any watched term." });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
export interface EffectiveTopic extends Topic {
  includes: string[];
  paused: string[];
  excludes: { term: string; appliesTo: string | null }[];
  /** true when the topic has no watch terms yet and its legacy keywords are being used */
  legacy: boolean;
}

/** The topic as the pipeline should see it: `keywords` is the ACTIVE include list, so every source adapter queries the watchlist. */
export function effectiveTopic(topic: Topic, terms: WatchTerm[]): EffectiveTopic {
  const mine = terms.filter((t) => t.topic_id === topic.id);
  if (!mine.length) return { ...topic, includes: [...topic.keywords], paused: [], excludes: [], legacy: true };
  const byId = new Map(mine.map((t) => [t.id, t.term]));
  const includes = mine.filter((t) => t.kind === "include" && t.status === "active").map((t) => t.term);
  return {
    ...topic,
    keywords: includes,
    includes,
    paused: mine.filter((t) => t.kind === "include" && t.status === "paused").map((t) => t.term),
    excludes: mine.filter((t) => t.kind === "exclude" && t.status === "active").map((t) => ({ term: t.term, appliesTo: t.applies_to ? (byId.get(t.applies_to) ?? null) : null })),
    legacy: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
export type MatchFlag = "title_match" | "body_only" | "ambiguous_term" | "early_variant" | "exclusion_overridden";
export type RejectReason = "no_match" | "excluded" | "below_sensitivity";

export interface MatchResult {
  accepted: boolean;
  reason: RejectReason | null;
  terms: string[];
  flags: MatchFlag[];
  excludedBy: string | null;
}

/**
 * Decides whether a post is evidence for a topic. Deterministic rules:
 *  - A match is a whole-word occurrence of an ACTIVE include term (early mode also accepts plurals).
 *  - A topic-wide exclusion removes a post only if the phrase appears in the TITLE, or the post matched no term in its title.
 *    A title match for a watched term therefore survives a body-only exclusion hit (flagged exclusion_overridden).
 *  - An exclusion scoped to one term removes a post only if that is the ONLY term it matched.
 *  - Sensitivity: strict needs a title match or two distinct terms, and an ambiguous-only match needs a title match;
 *    balanced accepts any match (ambiguous-only matches are flagged); early also accepts plural variants.
 */
export function matchPost(post: { title: string; body: string }, topic: EffectiveTopic, sensitivity: Sensitivity): MatchResult {
  const tolerant = sensitivity === "early";
  const inTitle = matchAll(post.title, topic.includes, tolerant);
  const inText = matchAll(`${post.title} ${post.body}`, topic.includes, tolerant);
  const strictTitle = matchAll(post.title, topic.includes, false);
  const strictText = matchAll(`${post.title} ${post.body}`, topic.includes, false);
  const flags: MatchFlag[] = [];
  const reject = (reason: RejectReason, by: string | null = null): MatchResult => ({ accepted: false, reason, terms: inText, flags, excludedBy: by });
  if (!inText.length) return reject("no_match");

  flags.push(inTitle.length ? "title_match" : "body_only");
  if (tolerant && inText.some((t) => !strictText.includes(t))) flags.push("early_variant");
  const ambiguousOnly = inText.every((t) => ambiguityOf(t) !== null);
  if (ambiguousOnly) flags.push("ambiguous_term");

  let overridden: string | null = null;
  for (const ex of topic.excludes) {
    const hitTitle = matchAll(post.title, [ex.term], false).length > 0;
    const hitText = hitTitle || matchAll(post.body, [ex.term], false).length > 0;
    if (!hitText) continue;
    if (ex.appliesTo) {
      if (inText.every((t) => t === ex.appliesTo)) return reject("excluded", ex.term);
      overridden = ex.term; // other terms also matched: the exclusion does not apply to this post
    } else if (hitTitle || !inTitle.length) {
      return reject("excluded", ex.term);
    } else {
      overridden = ex.term;
    }
  }
  if (overridden) flags.push("exclusion_overridden");

  if (sensitivity === "strict") {
    const distinct = new Set(inText).size;
    if (!inTitle.length && distinct < 2) return reject("below_sensitivity");
    if (ambiguousOnly && !inTitle.length) return reject("below_sensitivity");
  }
  return { accepted: true, reason: null, terms: inText, flags, excludedBy: null };
}

// ---------------------------------------------------------------------------------------------------------------------------
export interface ClassificationPolicy {
  mode: Sensitivity;
  label: string;
  /** Lowest confidence at which a relevant classification counts. */
  minConfidence: number;
  /** Higher bar when the only matching term is ambiguous. */
  ambiguousMinConfidence: number;
  /** Strict mode refuses a classification that carries no confidence at all. */
  requireConfidence: boolean;
  /** Below this (but above minConfidence) a result is labelled an early signal rather than an established pain point. */
  earlySignalBelow: number | null;
  /** The instruction block placed in the model prompt for this mode. */
  instruction: string;
}

export function classificationPolicy(mode: Sensitivity): ClassificationPolicy {
  switch (mode) {
    case "strict":
      return {
        mode, label: "Strict", minConfidence: 0.7, ambiguousMinConfidence: 0.8, requireConfidence: true, earlySignalBelow: null,
        instruction: "SENSITIVITY: STRICT. Mark a post relevant ONLY if it clearly describes a developer's concrete, first-hand problem with the theme (not a general opinion, announcement, job listing or advertisement). If you are not sure, relevant must be false. Report your honest confidence from 0 to 1; use 0.7 or higher only when the evidence is explicit.",
      };
    case "early":
      return {
        mode, label: "Early discovery", minConfidence: 0.3, ambiguousMinConfidence: 0.45, requireConfidence: false, earlySignalBelow: 0.5,
        instruction: "SENSITIVITY: EARLY DISCOVERY. Also accept weaker or emerging signals: a developer hinting at friction, asking whether others have the problem, or describing a workaround. Mark these relevant but give them a LOW confidence (0.3 to 0.5) so they are shown as early signals, never as established findings. Still mark pure advertising, job listings and unrelated uses of a word as not relevant.",
      };
    default:
      return {
        mode: "balanced", label: "Balanced", minConfidence: 0.5, ambiguousMinConfidence: 0.65, requireConfidence: false, earlySignalBelow: null,
        instruction: "SENSITIVITY: BALANCED. Mark a post relevant if it describes a real developer problem with the theme, even briefly or second-hand. Treat opinion pieces without a concrete problem, announcements, advertising and job listings as not relevant. Report your honest confidence from 0 to 1.",
      };
  }
}

/** Does a classification with this confidence count as evidence under the policy? */
export function acceptsConfidence(policy: ClassificationPolicy, confidence: number | null, ambiguousOnly: boolean): boolean {
  if (confidence === null) return !policy.requireConfidence;
  return confidence >= (ambiguousOnly ? policy.ambiguousMinConfidence : policy.minConfidence);
}

// ---------------------------------------------------------------------------------------------------------------------------
export interface ConfigSnapshot {
  version: 1;
  capturedAt: string;
  sensitivity: Sensitivity;
  topics: { id: string; name: string; includes: string[]; paused: string[]; excludes: { term: string; appliesTo: string | null }[]; legacy: boolean }[];
}

/** The configuration a run used, in a stable order, for storing with the run and sealing with its report. */
export function snapshotConfig(topics: EffectiveTopic[], sensitivity: Sensitivity, at: Date): ConfigSnapshot {
  const sort = (xs: string[]) => [...xs].sort();
  return {
    version: 1, capturedAt: at.toISOString(), sensitivity,
    topics: [...topics].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((t) => ({
      id: t.id, name: t.name, includes: sort(t.includes), paused: sort(t.paused), legacy: t.legacy,
      excludes: [...t.excludes].sort((a, b) => a.term.localeCompare(b.term) || String(a.appliesTo).localeCompare(String(b.appliesTo))),
    })),
  };
}

/** Two snapshots are the same configuration if everything but the capture time matches. */
export const sameConfig = (a: ConfigSnapshot | null | undefined, b: ConfigSnapshot | null | undefined) =>
  Boolean(a && b) && JSON.stringify({ ...a, capturedAt: 0 }) === JSON.stringify({ ...b, capturedAt: 0 });

// ---------------------------------------------------------------------------------------------------------------------------
export type TermActivity = "paused" | "producing" | "low" | "none";
/** How much evidence a term has produced in the lookback window. Thresholds are fixed and shown in the UI. */
export const PRODUCING_AT = 3;
export function termActivity(term: Pick<WatchTerm, "status" | "kind">, matches: number): TermActivity {
  if (term.status === "paused") return "paused";
  if (term.kind === "exclude") return matches > 0 ? "producing" : "none"; // for exclusions: how many posts it removed
  return matches >= PRODUCING_AT ? "producing" : matches > 0 ? "low" : "none";
}

/** Counts, per term, the posts that matched it. `posts` carry the terms stored when they were collected. */
export function countTermMatches(posts: { matched_terms?: string[] | null }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of posts) for (const t of new Set(p.matched_terms ?? [])) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export interface TermChange { action: "add" | "remove" | "pause" | "resume" | "edit"; subject: string; before?: unknown; after?: unknown }
export function diffTerms(before: WatchTerm[], after: WatchTerm[]): TermChange[] {
  const key = (t: WatchTerm) => t.id;
  const b = new Map(before.map((t) => [key(t), t]));
  const a = new Map(after.map((t) => [key(t), t]));
  const out: TermChange[] = [];
  for (const [id, t] of a) {
    const old = b.get(id);
    if (!old) out.push({ action: "add", subject: `${t.kind}:${t.term}`, after: t });
    else if (old.term !== t.term) out.push({ action: "edit", subject: `${t.kind}:${old.term}`, before: old, after: t });
    else if (old.status !== t.status) out.push({ action: t.status === "paused" ? "pause" : "resume", subject: `${t.kind}:${t.term}`, before: old, after: t });
  }
  for (const [id, t] of b) if (!a.has(id)) out.push({ action: "remove", subject: `${t.kind}:${t.term}`, before: t });
  return out;
}
