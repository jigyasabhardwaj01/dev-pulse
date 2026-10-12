import { ago, type Health, type SourceState, type SourceTimeline, type StageState } from "@/lib/health";
import type { RunView } from "@/lib/report-model";
import { formatDateTime } from "@/lib/view";

const OUTCOME: Record<string, { cls: string; text: string }> = {
  succeeded: { cls: "ok", text: "Succeeded" }, partial: { cls: "warn", text: "Completed with issues" },
  failed: { cls: "bad", text: "Failed" }, running: { cls: "info", text: "Running" },
};
const SRC: Record<SourceState, { cls: string; text: string }> = {
  records: { cls: "ok", text: "Succeeded" }, zero: { cls: "ok", text: "Succeeded, no results" }, partial: { cls: "warn", text: "Partly collected" },
  failed: { cls: "bad", text: "Failed" }, not_checked: { cls: "neutral", text: "Not checked" }, unknown: { cls: "neutral", text: "No status" },
};
const STAGE: Record<StageState, { cls: string; text: string }> = { ok: { cls: "ok", text: "OK" }, warn: { cls: "warn", text: "Gap" }, bad: { cls: "bad", text: "Problem" }, neutral: { cls: "neutral", text: "n/a" }, unknown: { cls: "neutral", text: "Unknown" } };
const dur = (s: number | null) => (s === null ? "" : s >= 120 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);
const ms = (v: number | null) => (v === null ? "not recorded" : v >= 10_000 ? `${Math.round(v / 1000)} s` : `${v} ms`);

function SourceCard({ t, run, now }: { t: SourceTimeline; run: RunView; now: Date }) {
  const s = run.sources.find((x) => x.source === t.source);
  const st = SRC[t.latest.state];
  return (
    <li className={`card src-card state-${t.latest.state}`}>
      <div className="head"><strong>{t.name}</strong><span className={`pill ${st.cls}`}>{st.text}</span></div>
      <p className="small"><strong>{t.latest.headline}</strong>{t.latest.capped && <span className="pill info" style={{ marginLeft: 6 }}>Capped</span>}</p>
      <p className="small muted">{t.latest.consequence}</p>
      {s && <p className="small num">{s.fetched} fetched · {s.accepted} relevant · {s.inserted} new</p>}
      <p className="small faint">
        {t.lastAttemptAt ? <>Last attempt {ago(t.lastAttemptAt, now)}</> : "Never attempted"}
        {" · "}{t.lastCleanAt ? <>last fully successful fetch {ago(t.lastCleanAt, now)}</> : <>no fully successful fetch in the {t.runsChecked} recorded {t.runsChecked === 1 ? "run" : "runs"}</>}
        {t.problemStreak >= 2 ? <> · problem in {t.problemStreak} runs in a row</> : null}
      </p>
      {s && (
        <details className="tech">
          <summary>Technical details<span className="sr-only"> for {t.name}</span></summary>
          <dl>
            <div><dt>Topic fetches</dt><dd className="num">{s.topics.ok} ok · {s.topics.partial} partial · {s.topics.error} failed (of {s.topics.total})</dd></div>
            <div><dt>Requests</dt><dd className="num">{s.requestsKnown ? `${s.requests} made, ${s.failedRequests} failed` : "not recorded"}</dd></div>
            <div><dt>Longest topic fetch</dt><dd className="num">{ms(s.maxDurationMs)}</dd></div>
            <div><dt>Recorded reason</dt><dd>{s.reason ?? "none"}</dd></div>
            <div><dt>Page limit reached</dt><dd>{s.truncated ? "yes" : "no"}</dd></div>
            <div><dt>Requests retried</dt><dd className="num">{t.retries}</dd></div>
            <div><dt>Waited for rate limit</dt><dd className="num">{t.waitedMs > 0 ? `${Math.round(t.waitedMs / 1000)} s` : "none"}</dd></div>
          </dl>
        </details>
      )}
    </li>
  );
}

/** The most recent run as the page's centre: outcome, timing, the four pipeline stages, and each source. */
export default function LatestRun({ health, now }: { health: Health; now: Date }) {
  const r = health.latest;
  if (!r) return null;
  const o = OUTCOME[r.status] ?? { cls: "neutral", text: "Unknown status" };
  return (
    <section className="section" aria-labelledby="latest-heading">
      <div className="section-head"><h2 id="latest-heading">Latest run</h2><p>{r.periodLabel || r.weekStart}</p></div>
      <div className="card run">
        <div className="run-top">
          <div>
            <div className="chips-row">
              <span className={`pill ${o.cls}`}>{o.text}</span>
              <span className="pill neutral">{r.trigger === "backfill" ? "Backfill" : "Scheduled"}</span>
              {r.stuck && <span className="pill bad">Appears stuck: no finish recorded</span>}
            </div>
            <p className="muted small" style={{ marginTop: 8 }}>
              Started {formatDateTime(r.startedAt)}{r.finishedAt ? <> · finished {formatDateTime(r.finishedAt)}</> : " · not finished"}{r.durationSec !== null ? <> · took {dur(r.durationSec)}</> : null}
            </p>
            <p className="muted small num">
              {r.fetchedTotal !== null ? `${r.fetchedTotal} fetched` : "fetched: not recorded"}{" · "}{r.newPosts !== null ? `${r.newPosts} new` : "new: not recorded"}{" · "}{r.classified !== null ? `${r.classified} classified` : "classified: not recorded"}{(r.unclassified ?? 0) > 0 ? ` · ${r.unclassified} waiting` : ""}
            </p>
          </div>
        </div>
        <ul className="stages" aria-label="Pipeline stages in the latest run">
          {health.stages.map((s) => (
            <li key={s.key} className={`stage stage-${s.state}`}>
              <span className="stage-name">{s.name}</span>
              <span className={`pill ${STAGE[s.state].cls}`}>{STAGE[s.state].text}</span>
              <strong className="small">{s.headline}</strong>
              <span className="small muted">{s.detail}</span>
            </li>
          ))}
        </ul>
        {r.problem && <p className="alert warn small" role="alert"><span>{r.problem}</span></p>}
        {r.diagnostics.length > 0 ? (
          <details className="tech diag">
            <summary>Diagnostics ({r.diagnostics.length})</summary>
            <ul className="diag-list">
              {[...r.diagnostics].sort((a, b) => ({ error: 0, warning: 1, info: 2 } as const)[a.severity] - ({ error: 0, warning: 1, info: 2 } as const)[b.severity]).map((d, i) => (
                <li key={`${d.code}-${i}`}>
                  <span className={`pill ${d.severity === "error" ? "bad" : d.severity === "warning" ? "warn" : "neutral"}`}>{d.severity}</span>
                  <code>{d.code}</code>
                  <span className="muted small">{d.stage}{d.source ? ` · ${d.source}` : ""} · {formatDateTime(d.at)}</span>
                  <span className="small">{d.message}</span>
                  {d.remedy && <span className="small faint">Next: {d.remedy}</span>}
                </li>
              ))}
            </ul>
          </details>
        ) : r.warningCount !== null && r.warningCount > 0 ? <p className="faint small">{r.warningCount} warnings were recorded for this run (recorded before structured diagnostics). The full text is in the server logs, not shown here.</p> : null}
      </div>
      <h3 className="sr-only">Sources in the latest run</h3>
      <ul className="src-cards">{health.timelines.map((t) => <SourceCard key={t.source} t={t} run={r} now={now} />)}</ul>
    </section>
  );
}

