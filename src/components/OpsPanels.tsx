import type { Checkpoint } from "@/lib/checkpoints";
import { ago } from "@/lib/health";
import { alertKindLabel, readCheckpoint, type AlertRow } from "@/lib/ops";
import { formatDateTime } from "@/lib/view";
import type { Section } from "@/lib/ops-data";

const CP: Record<string, string> = { ok: "ok", attention: "warn", unknown: "neutral" };

export default function OpsPanels({ checkpoints, alerts, topics, now }: { checkpoints: Section<Checkpoint>; alerts: Section<AlertRow>; topics: Record<string, string>; now: Date }) {
  return (
    <>
      <section className="section" aria-labelledby="cp-h">
        <div className="section-head"><h2 id="cp-h">Collection checkpoints</h2><p className="muted small">Per source and topic. Only a complete, stored fetch moves the committed point.</p></div>
        {!checkpoints.ok ? <div className="card card-pad" role="status"><strong>Checkpoint records could not be read.</strong> <span className="muted">The database did not answer, so their state is unknown; it is not assumed healthy.</span></div>
          : checkpoints.rows.length === 0 ? <div className="card card-pad" role="status"><strong>No checkpoints recorded yet.</strong> <span className="muted">They are written by the first run on this release; until then no source has a committed range.</span></div>
            : (
              <div className="card table-wrap">
                <table className="tbl">
                  <caption className="sr-only">Collection checkpoints by source and topic</caption>
                  <thead><tr><th scope="col">Source</th><th scope="col">Topic</th><th scope="col">State</th><th scope="col">Last attempt</th><th scope="col">Last success</th><th scope="col">Committed through</th></tr></thead>
                  <tbody>
                    {checkpoints.rows.map((c) => {
                      const r = readCheckpoint(c, topics[c.topic_id] ?? "Unknown topic", now);
                      return (
                        <tr key={`${c.source}:${c.topic_id}`}>
                          <th scope="row">{r.sourceName}</th><td>{r.topic}</td>
                          <td><span className={`pill ${CP[r.state]}`}>{r.headline}</span><span className="muted small" style={{ display: "block" }}>{r.detail}</span></td>
                          <td className="num">{r.lastAttemptAt ? <span title={formatDateTime(r.lastAttemptAt)}>{ago(r.lastAttemptAt, now)}</span> : "not recorded"}</td>
                          <td className="num">{r.lastSuccessAt ? <span title={formatDateTime(r.lastSuccessAt)}>{ago(r.lastSuccessAt, now)}</span> : "not recorded"}</td>
                          <td className="num">{r.committedThrough ? formatDateTime(r.committedThrough) : "not recorded"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
      </section>

      <section className="section" aria-labelledby="al-h">
        <div className="section-head"><h2 id="al-h">Failure alerts</h2><p className="muted small">Sent by scheduled runs only: at most one per problem, three per kind per day.</p></div>
        {!alerts.ok ? <div className="card card-pad" role="status"><strong>Alert records could not be read.</strong> <span className="muted">Their state is unknown.</span></div>
          : alerts.rows.length === 0 ? <div className="card card-pad" role="status"><strong>No alert records.</strong> <span className="muted">Either no scheduled run has needed one, or none has run yet on this release. This is not proof that nothing failed; check the run history above.</span></div>
            : (
              <ul className="card card-pad history-list">
                {alerts.rows.map((a) => (
                  <li key={a.id}><span className="num muted">{formatDateTime(a.at)}</span> · <strong>{alertKindLabel(a.kind)}</strong> · report week {a.key.split(":")[1] ?? "?"} · <span className={`pill ${a.status === "sent" ? "ok" : "bad"}`}>{a.status === "sent" ? "Attempted" : "Failed"}</span></li>
                ))}
              </ul>
            )}
        <p className="muted small">An alert record means an email was submitted to the provider; it does not confirm inbox delivery.</p>
      </section>
    </>
  );
}
