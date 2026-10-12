import { supabaseFromEnv } from "./store";
import type { ThemeTrend } from "./types";

export interface BriefRow {
  week_start: string;
  narrative: string;
  top_pain_points: ThemeTrend[];
  created_at: string;
}

export async function getLatestBrief(): Promise<BriefRow | null> {
  const { data, error } = await supabaseFromEnv()
    .from("briefs").select("*").order("week_start", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data as BriefRow | null;
}

export interface HistoryData {
  series: string[];
  rows: Record<string, string | number>[]; // one row per week: { week, "<topic> · <theme>": count }
}

export async function getHistory(maxSeries = 8): Promise<HistoryData> {
  const db = supabaseFromEnv();
  const [aggs, topics] = await Promise.all([
    db.from("weekly_aggregates").select("week_start, topic_id, theme, mention_count").order("week_start"),
    db.from("topics").select("id, name"),
  ]);
  if (aggs.error) throw new Error(aggs.error.message);
  if (topics.error) throw new Error(topics.error.message);
  const names = new Map((topics.data ?? []).map((t) => [t.id as string, t.name as string]));

  const totals = new Map<string, number>();
  for (const a of aggs.data ?? []) {
    if (a.theme === "other") continue;
    const s = `${names.get(a.topic_id) ?? "?"} · ${a.theme}`;
    totals.set(s, (totals.get(s) ?? 0) + a.mention_count);
  }
  const series = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxSeries).map(([s]) => s);

  const weeks = [...new Set((aggs.data ?? []).map((a) => a.week_start as string))].sort();
  const rows = weeks.map((w) => {
    const row: Record<string, string | number> = { week: w };
    for (const s of series) row[s] = 0;
    for (const a of aggs.data ?? []) {
      const s = `${names.get(a.topic_id) ?? "?"} · ${a.theme}`;
      if (a.week_start === w && series.includes(s)) row[s] = a.mention_count;
    }
    return row;
  });
  return { series, rows };
}
