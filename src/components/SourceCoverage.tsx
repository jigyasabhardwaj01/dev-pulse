import { readCoverage, sourceRows, type Reliability } from "@/lib/insights";
import type { Comparison, Coverage } from "@/lib/coverage";
import { Icon } from "./Icons";
import { pct } from "@/lib/view";

const PILL = { ok: { cls: "ok", text: "Healthy" }, partial: { cls: "warn", text: "Partly collected" }, error: { cls: "bad", text: "Failed" } } as const;

/** Where the posts came from, with failure, partial collection, zero-but-healthy and capped kept distinct. */
export default function SourceCoverage({ sources }: { sources: Coverage | null | undefined }) {
  const rows = sourceRows(sources);
  if (!rows.length) return null;
  return (
    <section className="card card-pad section" aria-labelledby="src-heading">
      <h2 id="src-heading">Source coverage</h2>
      <ul className="src-list">
        {rows.map((r) => {
          const on = r.share === null ? 0 : Math.max(r.posts ? 1 : 0, Math.round(r.share * 10));
          return (
            <li key={r.source} className={`src ${r.status}`}>
              <div className="src-top">
                <span>{r.name}</span>
                <span style={{ display: "flex", gap: 6 }}>
                  {r.capped && <span className="pill info" title="Results hit the page limit, so counts may be understated">Capped</span>}
                  <span className={`pill ${PILL[r.status].cls}`}>{PILL[r.status].text}</span>
                </span>
              </div>
              <div className="dots" role="img" aria-label={r.share === null ? `${r.name}: no data collected` : `${r.name}: ${pct(r.share)} of collected posts`}>
                {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < on ? "on" : ""} />)}
              </div>
              <p className="src-sub">{r.state}{r.share !== null ? ` · ${pct(r.share)} of collected posts` : ""}</p>
            </li>
          );
        })}
      </ul>
      <p className="faint small">Collected posts include those that did not match a tracked theme, so they outnumber the mentions counted above.</p>
    </section>
  );
}

/** Detailed, collapsible notes. The always-visible one-liner lives in CoverageAlert. */
export function DataNotes({ sources, comparison, reliability }: { sources: Coverage | null | undefined; comparison: Comparison | null | undefined; reliability: Reliability }) {
  const reading = readCoverage(sources, comparison, reliability);
  const scope = { this: "This period", previous: "Previous period", both: "This and previous period" } as const;
  return (
    <details className="card notes" id="data-notes" open={reading.level === "warn" ? true : undefined}>
      <summary>Data notes{reading.notes.length ? ` (${reading.notes.length})` : ""}</summary>
      {reading.notes.length === 0 ? (
        <p className="muted small" style={{ padding: "0 18px 16px" }}>No coverage issues were recorded for this period or the one before it.</p>
      ) : (
        <ul>
          {reading.notes.map((n, i) => (
            <li key={i}>
              <Icon name={n.level === "warn" ? "alert" : "info"} size={16} />
              <span><strong className="small" style={{ color: n.level === "warn" ? "var(--warn)" : "var(--info)" }}>{scope[n.scope]}. </strong>{n.text}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
