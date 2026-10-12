import type { ModelCaller, ThemeTrend } from "./types";
import { rankPainPoints } from "./trend";

export interface BriefMeta {
  pending: number; // posts fetched but not yet classified (kept for logging; never shown in the brief)
  warnings: string[];
}

export const FIRST_WEEK_SENTENCE =
  "This is the first week of tracking, so there's nothing to compare against yet; trend arrows start appearing next week.";

interface Named { theme: string; category: string; mentions: number; unresolved: number }
export interface BriefFacts {
  firstWeek: boolean;
  newCount: number;
  totalMentions: number;
  loudest: Named | null;
  biggestMover: (Named & { was: number; direction: "up" | "down" }) | null;
}

const named = (t: ThemeTrend): Named => ({ theme: t.theme, category: t.topic_name, mentions: t.count, unresolved: t.unresolved_count });

/** Everything the brief may state, computed from aggregates only (never from post text). */
export function computeFacts(trends: ThemeTrend[]): BriefFacts {
  const ranked = rankPainPoints(trends, 100);
  const active = ranked.filter((t) => t.count > 0);
  const hasPrior = ranked.some((t) => t.previous > 0);
  const movers = ranked
    .filter((t) => t.previous > 0 && t.count !== t.previous)
    .sort((a, b) => Math.abs(b.count - b.previous) - Math.abs(a.count - a.previous) || b.count - a.count);
  const m = movers[0];
  return {
    firstWeek: !hasPrior,
    newCount: active.filter((t) => t.direction === "new").length,
    totalMentions: active.reduce((s, t) => s + t.count, 0),
    loudest: active[0] ? named(active[0]) : null,
    biggestMover: m ? { ...named(m), was: m.previous, direction: m.count > m.previous ? "up" : "down" } : null,
  };
}

const mentions = (n: number) => `${n} mention${n === 1 ? "" : "s"}`;
const newSentence = (n: number) =>
  n === 0 ? "No pain points are new this week." : `${n} pain point${n === 1 ? " is" : "s are"} new this week.`;

/** Deterministic 2-3 sentence brief from the same facts; used whenever Gemini fails or breaks the rules. */
export function buildFallbackNarrative(trends: ThemeTrend[], _meta?: BriefMeta): string {
  const f = computeFacts(trends);
  if (!f.loudest) return "No tracked developer conversations were found this week.";
  const l = f.loudest;
  const loud = `"${l.theme}" is the loudest pain point this week with ${mentions(l.mentions)}, ${l.unresolved} flagged unresolved.`;
  if (f.firstWeek) return `${FIRST_WEEK_SENTENCE} ${loud}`;
  const m = f.biggestMover;
  const move = m
    ? `"${m.theme}" moved the most, ${m.direction} from ${m.was} to ${m.mentions} mention${m.mentions === 1 ? "" : "s"}.`
    : `${loud.slice(0, -1)}, with no big movers.`;
  return m ? `${move} ${loud} ${newSentence(f.newCount)}` : `${move} ${newSentence(f.newCount)}`;
}

/** The model only ever sees aggregated numbers, never raw post text. */
export function buildBriefPrompt(trends: ThemeTrend[]): string {
  const f = computeFacts(trends);
  const facts = {
    total_mentions_this_week: f.totalMentions,
    pain_points_new_this_week: f.newCount,
    loudest: f.loudest && { pain_point: f.loudest.theme, category: f.loudest.category, mentions: f.loudest.mentions, flagged_unresolved: f.loudest.unresolved },
    biggest_mover: f.biggestMover && {
      pain_point: f.biggestMover.theme, category: f.biggestMover.category, direction: f.biggestMover.direction,
      mentions_last_week: f.biggestMover.was, mentions_this_week: f.biggestMover.mentions,
    },
  };
  const coldStart = f.firstWeek
    ? `THIS IS THE FIRST WEEK OF TRACKING. Your first sentence must be exactly: "${FIRST_WEEK_SENTENCE}" Then name the loudest pain point in one sentence. Do not mention any trend, movement or percentage.`
    : `This is a normal week with prior data. Name the single most important fact: the biggest mover if one is given, otherwise the loudest. Then, as its own separate sentence, state how many pain points are new this week (say "No pain points are new this week." if zero).`;
  return `You write the intro line of a Friday brief for a product manager. Use ONLY the facts below.

Rules:
- Exactly 2 to 3 sentences, plain prose. No lists, no headings, no markdown.
- Name the single most important fact. Never re-list every pain point; a structured list is shown right below your text.
- Refer to a pain point by its name only; do not repeat the category as a prefix.
- State facts only: volume, direction, unresolved counts. Give no recommendations, advice or "should" language; do not tell the reader what to prioritize.
- Never write the words "null", "categorized as", or "baseline". Do not mention field names.
- Do not invent numbers, causes or quotes.

${coldStart}

Facts (JSON):
${JSON.stringify(facts, null, 2)}`;
}

const BANNED = /\bnull\b|categori[sz]ed as|baseline|\b(should|recommend\w*|prioriti[sz]e\w*|consider|suggest\w*)\b/i;

/** Accepts the model text only if it obeys the hard rules; trims to 3 sentences. Returns null to force the fallback. */
export function sanitizeNarrative(text: string, firstWeek: boolean): string | null {
  const t = text.replace(/\*\*|^#+\s*/gm, "").replace(/\s+/g, " ").trim();
  if (t.length < 20 || BANNED.test(t) || /^[-*•]\s/m.test(text)) return null;
  const sentences = t.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (sentences.length < 2) return null;
  const out = sentences.slice(0, 3).join(" ");
  if (firstWeek && !out.includes("first week of tracking")) return null;
  return out;
}

export async function generateBrief(
  trends: ThemeTrend[],
  meta: BriefMeta,
  callModel: ModelCaller | null,
): Promise<{ narrative: string; usedFallback: boolean }> {
  const fallback = () => ({ narrative: buildFallbackNarrative(trends, meta), usedFallback: true });
  const facts = computeFacts(trends);
  if (!callModel || !facts.loudest) return fallback();
  const prompt = buildBriefPrompt(trends);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ok = sanitizeNarrative(await callModel(prompt), facts.firstWeek);
      if (ok) return { narrative: ok, usedFallback: false };
    } catch {
      return fallback(); // model outage: do not burn another call
    }
  }
  return fallback();
}
