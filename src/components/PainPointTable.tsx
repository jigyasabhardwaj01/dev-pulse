import Link from "next/link";
import { groupPainPoints } from "@/lib/grouping";
import { evidenceHref } from "@/lib/insights";
import { pct } from "@/lib/view";
import type { ThemeTrend } from "@/lib/types";
import MovementBadge from "./MovementBadge";

/** Pain points grouped by category, one compact comparable row each. Pass the output of `displayPoints`. */
export default function PainPointTable({ points, weekStart }: { points: ThemeTrend[]; weekStart: string }) {
  const groups = groupPainPoints(points);
  const max = Math.max(1, ...groups.flatMap((g) => g.items.map((i) => i.count)));
  const all = groups.reduce((s, g) => s + g.totalMentions, 0);
  if (!groups.length) {
    return (
      <section className="section" aria-labelledby="pp-heading">
        <h2 id="pp-heading">Pain points by category</h2>
        <div className="card empty"><h2>No pain points recorded</h2><p className="muted">Nothing in this period matched a tracked theme.</p></div>
      </section>
    );
  }
  return (
    <section className="section" aria-labelledby="pp-heading">
      <div className="section-head">
        <h2 id="pp-heading">Pain points by category</h2>
        <p className="legend" aria-hidden="true">
          <span><i className="l-total" />Mentions (bar length = share of the largest)</span>
          <span><i className="l-unres" />Share flagged unresolved</span>
        </p>
      </div>
      {groups.map((g) => (
        <section key={g.topic_id} className="card cat" aria-label={g.category}>
          <div className="cat-head">
            <h3>{g.category}</h3>
            <span className="totals"><span className="num">{g.totalMentions} {g.totalMentions === 1 ? "mention" : "mentions"}</span><span className="faint">{all ? pct(g.totalMentions / all) : "–"} of this report</span></span>
          </div>
          <div className="pp-cols" aria-hidden="true"><span>Pain point</span><span>Mentions</span><span style={{ textAlign: "right" }}>#</span><span>Change</span><span /></div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {g.items.map((i) => (
              <li key={i.theme} className="pp-row">
                <div className="pp-title">
                  <span>{i.theme}</span>
                  <span className="small muted">
                    {i.mostlyUnresolved ? <span className="pill warn">⚑ Mostly unresolved</span> : null}
                    {" "}<span className="num">{i.unresolved_count} of {i.count} flagged unresolved</span>
                  </span>
                </div>
                <div className="bar" role="img" aria-label={`${i.count} mentions, ${i.unresolved_count} flagged unresolved${i.count ? ` (${pct(i.unresolved_count / i.count)})` : ""}`}>
                  {i.count > 0 && (
                    <span className="bar-fill" style={{ width: `${Math.max(3, (i.count / max) * 100)}%`, display: "block" }}>
                      {i.unresolved_count > 0 && <span className="bar-unres" style={{ width: `${(i.unresolved_count / i.count) * 100}%` }} />}
                    </span>
                  )}
                </div>
                <div className="pp-count">{i.count}</div>
                <div className="pp-move"><MovementBadge item={i} showCounts /></div>
                <div>{i.count > 0 ? <Link className="pp-link" href={evidenceHref(i, weekStart)}>Evidence <span aria-hidden="true">→</span><span className="sr-only"> for {i.theme}</span></Link> : <span className="faint small">No posts</span>}</div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
