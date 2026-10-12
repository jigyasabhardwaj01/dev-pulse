import Link from "next/link";
import { groupPainPoints, mentionsLine, trendArrow, trendLabel } from "@/lib/grouping";
import type { ThemeTrend } from "@/lib/types";

export default function GroupedPainPoints({ points, weekStart }: { points: ThemeTrend[]; weekStart: string }) {
  const groups = groupPainPoints(points);
  if (!groups.length) return <p className="empty">No pain points recorded this week.</p>;
  return (
    <>
      {groups.map((g) => (
        <section key={g.topic_id} className="group">
          <h3>{g.category}</h3>
          <ul className="items">
            {g.items.map((i) => (
              <li key={i.theme}>
                <div className="item-main">
                  <strong>{i.theme}</strong>
                  <span className="meta">{mentionsLine(i)}</span>
                </div>
                <div className="item-side">
                  <span className={`trend ${i.direction}`}>{trendArrow(i.direction)} {trendLabel(i)}</span>
                  {i.mostlyUnresolved && <span className="badge">⚑ mostly unresolved</span>}
                  {i.count > 0 && (
                    <Link className="viewposts" href={`/posts?topic=${i.topic_id}&theme=${encodeURIComponent(i.theme)}&week=${weekStart}`}>
                      view posts
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
