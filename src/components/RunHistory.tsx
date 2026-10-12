import { historyInsights, label, readSource } from "@/lib/health";
import type { RunView } from "@/lib/report-model";
import { formatDateTime } from "@/lib/view";

const OUTCOME: Record<string, { cls: string; text: string }> = {
  succeeded: { cls: "ok", text: "Succeeded" }, partial: { cls: "warn", text: "Issues" }, failed: { cls: "bad", text: "Failed" }, running: { cls: "info", text: "Running" },
};

/** Compact history for spotting repeats. Insights appear only when the records are enough to support them. */
export default function RunHistory({ runs }: { runs: RunView[] }) {
  const ins = historyInsights(runs);
  const problems = (r: RunView) => r.sources.filter((s) => { const st = readSource(s, s.source).state; return st === "partial" || st === "failed"; }).map((s) => `${label(s.source)} ${readSource(s, s.source).state === "failed" ? "failed" : "partial"}`);
  return (
    <section className="section" aria-labelledby="hist-heading">
      <div className="section-head"><h2 id="hist-heading">Recent runs</h2><p>{runs.length} {runs.length === 1 ? "run" : "runs"} shown, newest first</p></div>
      {(ins.noSuccessStreak > 0 || ins.recurring.length > 0 || ins.duration) && (
        <div className="card card-pad">
          <ul className="insights">
            {ins.noSuccessStreak > 0 && <li><strong>{ins.noSuccessStreak} runs in a row</strong> have not fully succeeded.</li>}
            {ins.recurring.map((x) => <li key={x.source}><strong>{x.name}</strong> was partial or failed in {x.runs} of {x.of} runs{x.streak >= 2 ? `, including the latest ${x.streak} in a row` : ""}.</li>)}
            {ins.duration && <li>Latest run took <strong>{ins.duration.latestSec} s</strong>; the {ins.duration.of} recorded runs ranged from {ins.duration.minSec} to {ins.duration.maxSec} s.</li>}
          </ul>
        </div>
      )}
      {!ins.duration && runs.length > 0 && <p className="faint small">Run-time and count trends need at least 3 recorded runs, so none is drawn. Backfills and scheduled runs are not directly comparable.</p>}
      <ul className="report-cards">
        {runs.map((r, i) => {
          const o = OUTCOME[r.status] ?? { cls: "neutral", text: "Unknown" };
          const p = problems(r);
          return (
            <li key={r.id} className="card report-card run-row">
              <div className="rc-title">
                <strong>{r.periodLabel || r.weekStart}{i === 0 ? <span className="pill accent" style={{ marginLeft: 8 }}>Latest</span> : null}</strong>
                <span className="muted small">{formatDateTime(r.startedAt)} · {r.trigger === "backfill" ? "Backfill" : "Scheduled"}{r.durationSec !== null ? ` · ${r.durationSec} s` : ""}</span>
                <span className="chips-row" style={{ gap: 6 }}>
                  <span className={`pill ${o.cls}`}>{o.text}</span>
                  {r.stuck && <span className="pill bad">Appears stuck</span>}
                  {p.map((x) => <span key={x} className="pill warn">{x}</span>)}
                </span>
              </div>
              <div className="rc-stats">
                <div className="rc-stat"><b className="num">{r.fetchedTotal ?? "–"}</b><span>Fetched</span></div>
                <div className="rc-stat"><b className="num">{r.newPosts ?? "–"}</b><span>New</span></div>
                <div className="rc-stat"><b className="num">{r.classified ?? "–"}</b><span>Classified</span></div>
                <div className="rc-stat"><b className="num">{r.unclassified ?? "–"}</b><span>Waiting</span></div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
