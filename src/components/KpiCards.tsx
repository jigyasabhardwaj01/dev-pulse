import type { Kpis } from "@/lib/insights";
import { pct } from "@/lib/view";

/** Compact support for the main intelligence. A missing baseline is shown as such, never as zero or a percentage. */
export default function KpiCards({ kpis }: { kpis: Kpis }) {
  const cards = [
    { label: "Relevant mentions", value: String(kpis.mentions), sub: kpis.previousMentions !== null ? <><span className="num">{kpis.mentions - kpis.previousMentions >= 0 ? "+" : "−"}{Math.abs(kpis.mentions - kpis.previousMentions)}</span> vs {kpis.previousMentions} last week</> : "matched to a tracked theme" },
    { label: "Tracked pain points", value: String(kpis.painPoints), sub: "with at least one mention" },
    { label: "Newly emerging", value: kpis.emerging === null ? "–" : String(kpis.emerging), sub: kpis.emerging === null ? "not compared this week" : "not seen last week" },
    { label: "Unresolved", value: String(kpis.unresolvedMentions), sub: kpis.mentions ? `${pct(kpis.unresolvedShare)} of mentions · ${kpis.unresolvedPainPoints} mostly unresolved` : "no mentions" },
  ];
  return (
    <section className="kpis" aria-label="Key figures">
      {cards.map((c) => (
        <div key={c.label} className="card kpi">
          <span className="k-label">{c.label}</span>
          <span className="k-value">{c.value}</span>
          <span className="k-sub">{c.sub}</span>
        </div>
      ))}
    </section>
  );
}
