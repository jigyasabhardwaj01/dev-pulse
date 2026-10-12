import Link from "next/link";
import { groupPainPoints, mentionsLine } from "@/lib/grouping";
import { pct } from "@/lib/view";
import type { ThemeTrend } from "@/lib/types";
import TrendBadge from "./TrendBadge";

/** Pain points grouped by category. Pass the output of `displayPoints` so unreliable trends are already withheld. */
export default function PainPointGroups({ points, weekStart }: { points: ThemeTrend[]; weekStart: string }) {
  const groups = groupPainPoints(points);
  const max = Math.max(1, ...groups.flatMap((g) => g.items.map((i) => i.count)));
  if (!groups.length) {
    return (
      <div className="card empty">
        <h2>No pain points recorded</h2>
        <p className="muted">Nothing in this period matched a tracked theme.</p>
      </div>
    );
  }
  return (
    <section aria-labelledby="pp-heading" className="group" style={{ gap: 18 }}>
      <div className="group-head">
        <h2 id="pp-heading">Pain points by category</h2>
        <p className="legend" aria-hidden="true">
          <span><i className="l-total" />Mentions</span>
          <span><i className="l-unres" />Share flagged unresolved</span>
        </p>
      </div>
      {groups.map((g) => (
        <section key={g.topic_id} className="group" aria-label={g.category}>
          <div className="group-head">
            <h3>{g.category}</h3>
            <span className="muted small">{g.totalMentions} {g.totalMentions === 1 ? "mention" : "mentions"}</span>
          </div>
          <ul className="items card">
            {g.items.map((i) => (
              <li key={i.theme} className="item">
                <div className="item-top">
                  <div>
                    <span className="theme">{i.theme}</span>{" "}
                    {i.mostlyUnresolved && <span className="pill warn">⚑ mostly unresolved</span>}
                  </div>
                  <TrendBadge item={i} />
                </div>
                {i.count > 0 && (
                  <div
                    className="bar"
                    role="img"
                    aria-label={`${i.count} mentions, ${i.unresolved_count} flagged unresolved (${pct(i.unresolved_count / i.count)})`}
                  >
                    <span className="bar-total" style={{ width: `${Math.max(3, (i.count / max) * 100)}%` }}>
                      {i.unresolved_count > 0 && <span className="bar-unres" style={{ width: `${(i.unresolved_count / i.count) * 100}%` }} />}
                    </span>
                  </div>
                )}
                <div className="item-meta">
                  <span>{mentionsLine(i)}</span>
                  {i.count > 0 && (
                    <Link href={`/posts?topic=${i.topic_id}&theme=${encodeURIComponent(i.theme)}&week=${weekStart}`}>
                      View the {i.count === 1 ? "post" : "posts"} <span aria-hidden="true">→</span>
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
