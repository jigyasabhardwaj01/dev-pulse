import { type AttentionItem } from "@/lib/health";
import { formatDateTime } from "@/lib/view";

const WORD = { bad: "Needs action", warn: "Gap", info: "Limit" } as const;
const PILL = { bad: "bad", warn: "warn", info: "info" } as const;

/** One consolidated list instead of repeating each warning. Each item says what, where, when, the effect and the next step. */
export default function AttentionList({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <section className="section" aria-labelledby="att-heading">
        <h2 id="att-heading">What needs attention</h2>
        <div className="card card-pad"><p className="muted">Nothing needs attention from the latest run.</p></div>
      </section>
    );
  }
  return (
    <section className="section" aria-labelledby="att-heading">
      <div className="section-head"><h2 id="att-heading">What needs attention <span className="muted num">({items.length})</span></h2><p>From the latest run, most important first</p></div>
      <ul className="att-list">
        {items.map((i) => (
          <li key={i.id} className={`card att att-${i.level}`}>
            <div className="att-top">
              <span className={`pill ${PILL[i.level]}`}>{WORD[i.level]}</span>
              <span className="pill neutral">{i.where}</span>
              <strong>{i.what}</strong>
              {i.when && <span className="muted small">{formatDateTime(i.when)}</span>}
            </div>
            <p className="small"><span className="faint">Effect: </span>{i.effect}</p>
            <p className="small"><span className="faint">Next: </span>{i.next}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
