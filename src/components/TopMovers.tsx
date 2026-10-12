import Link from "next/link";
import { evidenceHref, type Mover, type Movers } from "@/lib/insights";
import MovementBadge from "./MovementBadge";

function Col({ title, items, weekStart, empty }: { title: string; items: Mover[]; weekStart: string; empty: string }) {
  return (
    <div className="mover-col">
      <h3>{title}</h3>
      {items.length === 0 ? <p className="mover-empty">{empty}</p> : (
        <ul className="mover-list">
          {items.map((m) => (
            <li key={`${m.topic_id}-${m.theme}`}>
              <Link className="mover" href={evidenceHref(m, weekStart)}>
                <span className="m-name">{m.theme}</span>
                <span className="m-meta">
                  <MovementBadge item={{ direction: m.move.kind === "na" ? "unavailable" : m.move.kind === "up" ? "up" : m.move.kind === "down" ? "down" : m.move.kind === "new" ? "new" : "flat", count: m.count, previous: m.previous, pct: null }} />
                  <span className="num">{m.count} {m.count === 1 ? "mention" : "mentions"}</span>
                  {m.move.counts && <span className="num faint">{m.move.counts}</span>}
                </span>
                <span className="sr-only">View the evidence for {m.theme}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A compact strip of the most significant changes. Each item links to its evidence. */
export default function TopMovers({ movers, weekStart, previousLabel }: { movers: Movers; weekStart: string; previousLabel: string | null }) {
  return (
    <section className="section" aria-labelledby="movers-heading">
      <div className="section-head">
        <h2 id="movers-heading">Top movers</h2>
        <p>{movers.comparable ? `Change vs ${previousLabel ?? "the previous period"}, in mentions` : "Trends are withheld this week, so ranking is by size and unresolved mentions"}</p>
      </div>
      <div className="card movers">
        {movers.comparable ? (
          <>
            <Col title="Largest increases" items={movers.increases} weekStart={weekStart} empty="No pain point rose." />
            <Col title="Newly emerging" items={movers.emerging} weekStart={weekStart} empty="Nothing new this week." />
            <Col title="Largest decreases" items={movers.decreases} weekStart={weekStart} empty="No pain point fell." />
            <Col title="Unresolved to watch" items={movers.unresolved} weekStart={weekStart} empty="Nothing flagged unresolved." />
          </>
        ) : (
          <>
            <Col title="Biggest pain points" items={movers.biggest} weekStart={weekStart} empty="No mentions this period." />
            <Col title="Unresolved to watch" items={movers.unresolved} weekStart={weekStart} empty="Nothing flagged unresolved." />
          </>
        )}
      </div>
    </section>
  );
}
