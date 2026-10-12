import type { ModelCaller, ThemeTrend } from "./types";
import type { ComparisonState } from "./coverage";
import { rankPainPoints } from "./trend";

export interface BriefMeta {
  pending: number; // posts fetched but not yet classified (kept for logging; never shown in the brief)
  warnings: string[];
}

export const FIRST_WEEK_SENTENCE =
  "This is the first week of tracking, so there's nothing to compare against yet; trend arrows start appearing next week.";
export const NOT_COMPARED_SENTENCE =
  "Week-over-week trends are not compared this week because source coverage differs from the previous period.";

interface Named { theme: string; category: string; mentions: number; unresolved: number }
export interface BriefFacts {
  state: ComparisonState;
  firstWeek: boolean; // kept for existing callers: true when there is nothing to compare against
  newCount: number;
  totalMentions: number;
  loudest: Named | null;
  biggestMover: (Named & { was: number; direction: "up" | "down" }) | null;
}

const named = (t: ThemeTrend): Named => ({ theme: t.theme, category: t.topic_name, mentions: t.count, unresolved: t.unresolved_count });

/**
 * Everything the brief may state, computed from aggregates only (never from post text).
 * Movement and "new" counts exist only when the comparison is fair; otherwise they are withheld.
 * With no explicit state, one is inferred from the trends (previous counts present or not).
 */
export function computeFacts(trends: ThemeTrend[], state?: ComparisonState): BriefFacts {
  const ranked = rankPainPoints(trends, 100);
  const active = ranked.filter((t) => t.count > 0);
  const resolved: ComparisonState = state ?? (ranked.some((t) => t.previous > 0) ? "comparable" : "no_prior");
  const comparable = resolved === "comparable";
  const movers = comparable
    ? ranked
        .filter((t) => t.previous > 0 && t.count !== t.previous)
        .sort((a, b) => Math.abs(b.count - b.previous) - Math.abs(a.count - a.previous) || b.count - a.count)
    : [];
  const m = movers[0];
  return {
    state: resolved,
    firstWeek: resolved === "no_prior",
    newCount: comparable ? active.filter((t) => t.direction === "new").length : 0,
    totalMentions: active.reduce((s, t) => s + t.count, 0),
    loudest: active[0] ? named(active[0]) : null,
    biggestMover: m ? { ...named(m), was: m.previous, direction: m.count > m.previous ? "up" : "down" } : null,
  };
}

const mentions = (n: number) => `${n} mention${n === 1 ? "" : "s"}`;
const newSentence = (n: number) =>
  n === 0 ? "No pain points are new this week." : `${n} pain point${n === 1 ? " is" : "s are"} new this week.`;

/** Deterministic 2-3 sentence brief from the same facts; used whenever the AI model fails or breaks the rules. */
export function buildFallbackNarrative(trends: ThemeTrend[], _meta?: BriefMeta, state?: ComparisonState): string {
  const f = computeFacts(trends, state);
  if (!f.loudest) return "No tracked developer conversations were found this week.";
  const l = f.loudest;
  const loud = `"${l.theme}" is the loudest pain point this week with ${mentions(l.mentions)}, ${l.unresolved} flagged unresolved.`;
  if (f.state === "no_prior") return `${FIRST_WEEK_SENTENCE} ${loud}`;
  if (f.state === "incomparable") return `${NOT_COMPARED_SENTENCE} ${loud}`;
  const m = f.biggestMover;
  const move = m
    ? `"${m.theme}" moved the most, ${m.direction} from ${m.was} to ${m.mentions} mention${m.mentions === 1 ? "" : "s"}.`
    : `${loud.slice(0, -1)}, with no big movers.`;
  return m ? `${move} ${loud} ${newSentence(f.newCount)}` : `${move} ${newSentence(f.newCount)}`;
}

/** The model only ever sees aggregated numbers, never raw post text. */
export function buildBriefPrompt(trends: ThemeTrend[], state?: ComparisonState): string {
  const f = computeFacts(trends, state);
  const facts = {
    total_mentions_this_week: f.totalMentions,
    ...(f.state === "comparable" ? { pain_points_new_this_week: f.newCount } : {}),
    loudest: f.loudest && { pain_point: f.loudest.theme, category: f.loudest.category, mentions: f.loudest.mentions, flagged_unresolved: f.loudest.unresolved },
    ...(f.state === "comparable"
      ? {
          biggest_mover: f.biggestMover && {
            pain_point: f.biggestMover.theme, category: f.biggestMover.category, direction: f.biggestMover.direction,
            mentions_last_week: f.biggestMover.was, mentions_this_week: f.biggestMover.mentions,
          },
        }
      : {}),
  };
  const mode =
    f.state === "no_prior"
      ? `THIS IS THE FIRST WEEK OF TRACKING. Your first sentence must be exactly: "${FIRST_WEEK_SENTENCE}" Then name the loudest pain point in one sentence. Do not mention any trend, movement or percentage.`
      : f.state === "incomparable"
        ? `LAST WEEK'S DATA CANNOT BE COMPARED FAIRLY. Your first sentence must be exactly: "${NOT_COMPARED_SENTENCE}" Then name the loudest pain point in one sentence. Do not mention any trend, movement, increase, decrease, percentage or number of new pain points.`
        : `This is a normal week with prior data. Name the single most important fact: the biggest mover if one is given, otherwise the loudest. Then, as its own separate sentence, state how many pain points are new this week (say "No pain points are new this week." if zero).`;
  return `You write the intro line of a Friday brief for a product manager. Use ONLY the facts below.

Rules:
- Exactly 2 to 3 sentences, plain prose. No lists, no headings, no markdown.
- Name the single most important fact. Never re-list every pain point; a structured list is shown right below your text.
- Refer to a pain point by its name only; do not repeat the category as a prefix.
- State facts only: volume, direction, unresolved counts. Give no recommendations, advice or "should" language; do not tell the reader what to prioritize.
- Never write the words "null", "categorized as", or "baseline". Do not mention field names.
- Do not invent numbers, causes or quotes.

${mode}

Facts (JSON):
${JSON.stringify(facts, null, 2)}`;
}

const BANNED = /\bnull\b|categori[sz]ed as|baseline|\b(should|recommend\w*|prioriti[sz]e\w*|consider|suggest\w*)\b/i;
const TREND_WORDS = /\b(up|down|rose|fell|increase\w*|decrease\w*|declin\w*|grew|growth|surge\w*|drop\w*|new)\b|%/i;

/**
 * Accepts the model text only if it obeys the hard rules; trims to 3 sentences. Returns null to force the fallback.
 * `mode` may be a ComparisonState, or a boolean for existing callers (true = nothing to compare against).
 */
export function sanitizeNarrative(text: string, mode: ComparisonState | boolean): string | null {
  const state: ComparisonState = typeof mode === "boolean" ? (mode ? "no_prior" : "comparable") : mode;
  const t = text.replace(/\*\*|^#+\s*/gm, "").replace(/\s+/g, " ").trim();
  if (t.length < 20 || BANNED.test(t) || /^[-*•]\s/m.test(text)) return null;
  const sentences = t.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (sentences.length < 2) return null;
  const out = sentences.slice(0, 3).join(" ");
  if (state === "no_prior" && !out.includes("first week of tracking")) return null;
  if (state === "incomparable") {
    if (!out.includes("not compared")) return null;
    // everything after the mandated first sentence must not describe movement we have declared unreliable
    if (TREND_WORDS.test(sentences.slice(1, 3).join(" "))) return null;
  }
  return out;
}

export async function generateBrief(
  trends: ThemeTrend[],
  meta: BriefMeta,
  callModel: ModelCaller | null,
  state?: ComparisonState,
  deadline?: number,
): Promise<{ narrative: string; usedFallback: boolean }> {
  const fallback = () => ({ narrative: buildFallbackNarrative(trends, meta, state), usedFallback: true });
  const facts = computeFacts(trends, state);
  if (!callModel || !facts.loudest) return fallback();
  const prompt = buildBriefPrompt(trends, state);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ok = sanitizeNarrative(await callModel(prompt, { deadline }), facts.state);
      if (ok) return { narrative: ok, usedFallback: false };
    } catch {
      return fallback(); // model outage or exhausted time budget: do not burn another call
    }
  }
  return fallback();
}
