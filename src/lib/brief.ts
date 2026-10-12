import type { ModelCaller, ThemeTrend } from "./types";
import { rankPainPoints } from "./trend";

export interface BriefMeta {
  pending: number; // posts fetched but not yet classified
  warnings: string[];
}

const label = (t: ThemeTrend) => `${t.topic_name} · ${t.theme}`;

export function describeTrend(t: ThemeTrend): string {
  switch (t.direction) {
    case "new": return `new this week (${t.count} mention${t.count === 1 ? "" : "s"}, none last week)`;
    case "up": return `up ${t.pct}% (${t.previous} → ${t.count})`;
    case "down": return t.count === 0
      ? `dropped to zero (was ${t.previous} last week)`
      : `down ${Math.abs(t.pct ?? 0)}% (${t.previous} → ${t.count})`;
    default: return `flat at ${t.count}`;
  }
}

/** Deterministic brief built from the same numbers, used whenever Gemini fails. */
export function buildFallbackNarrative(trends: ThemeTrend[], meta: BriefMeta): string {
  const ranked = rankPainPoints(trends, 8);
  const active = ranked.filter((t) => t.count > 0);
  if (active.length === 0 && ranked.length === 0) {
    return "No tracked developer conversations were found this week." + noteFor(meta);
  }
  const lines: string[] = [];
  if (active.length) {
    const top = active[0];
    lines.push(`The most discussed pain point this week was "${label(top)}" with ${top.count} mentions, ${describeTrend(top)}.`);
  }
  for (const t of ranked.slice(0, 8)) {
    lines.push(`- ${label(t)}: ${describeTrend(t)}${t.unresolved ? "; mostly unresolved" : ""}.`);
  }
  const unresolved = active.filter((t) => t.unresolved);
  if (unresolved.length) {
    lines.push(`Looks underserved: ${unresolved.map(label).join("; ")}.`);
  }
  return lines.join("\n") + noteFor(meta);
}

function noteFor(meta: BriefMeta): string {
  const notes: string[] = [];
  if (meta.pending > 0) notes.push(`${meta.pending} post(s) are still awaiting classification and are not counted yet`);
  notes.push(...meta.warnings.slice(0, 3));
  return notes.length ? `\n\nData notes: ${notes.join("; ")}.` : "";
}

/** The model only ever sees aggregated numbers, never raw post text. */
export function buildBriefPrompt(trends: ThemeTrend[], meta: BriefMeta): string {
  const data = rankPainPoints(trends, 10).map((t) => ({
    pain_point: label(t),
    mentions_this_week: t.count,
    mentions_last_week: t.previous,
    trend: t.direction,
    change_pct: t.pct,
    unresolved_mentions: t.unresolved_count,
    mostly_unresolved: t.unresolved,
  }));
  return `You write a short Friday brief for a product manager of a code-review automation tool.
Use ONLY the aggregated data below. Do not invent counts, quotes, causes or patterns not present in it.
Write 2 short paragraphs of plain prose: (1) what is loudest and what is rising or falling, noting "new" items have no baseline; (2) which pain points look unresolved/underserved. No headings, no bullet lists.
${meta.pending ? `Note: ${meta.pending} posts were not yet classified and are excluded.\n` : ""}
Data (JSON):
${JSON.stringify(data, null, 2)}`;
}

export async function generateBrief(
  trends: ThemeTrend[],
  meta: BriefMeta,
  callModel: ModelCaller | null,
): Promise<{ narrative: string; usedFallback: boolean }> {
  const fallback = () => ({ narrative: buildFallbackNarrative(trends, meta), usedFallback: true });
  if (!callModel || rankPainPoints(trends, 1).length === 0) return fallback();
  try {
    const text = (await callModel(buildBriefPrompt(trends, meta))).trim();
    if (text.length < 20) return fallback();
    return { narrative: text + noteFor({ pending: meta.pending, warnings: [] }), usedFallback: false };
  } catch {
    return fallback();
  }
}
