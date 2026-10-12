import { pct, type ReportStats } from "@/lib/view";

export default function StatTiles({ stats, showSources }: { stats: ReportStats; showSources: boolean }) {
  const tiles = [
    { label: "Mentions", value: String(stats.mentions), hint: "matched to a tracked theme" },
    { label: "Pain points", value: String(stats.painPoints), hint: stats.topCategory ? `most in ${stats.topCategory}` : "none this period" },
    { label: "Flagged unresolved", value: stats.mentions ? pct(stats.unresolvedShare) : "–", hint: `${stats.unresolvedMentions} of ${stats.mentions} mentions` },
    ...(showSources ? [{ label: "Sources healthy", value: `${stats.sourcesOk}/${stats.sourcesTotal}`, hint: stats.sourcesNeedingAttention.length ? `${stats.sourcesNeedingAttention.length} need attention` : "all fetched cleanly" }] : []),
  ];
  return (
    <section className="tiles" aria-label="Report totals">
      {tiles.map((t) => (
        <div key={t.label} className="card tile">
          <span className="label">{t.label}</span>
          <span className="value">{t.value}</span>
          <span className="hint">{t.hint}</span>
        </div>
      ))}
    </section>
  );
}
