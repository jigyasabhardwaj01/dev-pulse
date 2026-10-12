import type { Metadata } from "next";
import EmptyState from "@/components/EmptyState";
import { SOURCE_LABEL } from "@/lib/coverage";
import { getRecentRuns } from "@/lib/data";
import { formatDateTime } from "@/lib/view";

export const metadata: Metadata = { title: "Pipeline" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, { cls: string; text: string }> = {
  succeeded: { cls: "ok", text: "Succeeded" }, partial: { cls: "warn", text: "Completed with issues" },
  failed: { cls: "bad", text: "Failed" }, running: { cls: "info", text: "Running" },
};
const SRC: Record<string, string> = { ok: "ok", partial: "partly failed", error: "failed" };

/** Read-only health view. Nothing here can start, stop or change a run. */
export default async function Status() {
  let runs = null;
  let failed = false;
  try { runs = await getRecentRuns(10); } catch { failed = true; }
  if (failed) return <EmptyState title="We couldn't load run history" body="The database didn't answer. Try again in a moment." />;
  if (runs === null) return <EmptyState title="Run history isn't available yet" body="It starts recording once the reliability update has been applied to the database." />;
  if (!runs.length) return <EmptyState title="No runs recorded yet" body="Each scheduled or backfill run appears here with the health of every source." />;

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Operations</p>
        <h1>Pipeline health</h1>
        <p className="muted">The most recent runs and how each source behaved. A failed source is shown as failed, never as &ldquo;zero posts&rdquo;.</p>
      </header>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 14 }}>
        {runs.map((r) => {
          const st = STATUS[r.status] ?? { cls: "neutral", text: r.status };
          return (
            <li key={r.id} className="card" style={{ padding: "16px 18px", display: "grid", gap: 10 }}>
              <div className="item-top">
                <div>
                  <strong>{r.periodLabel || r.weekStart}</strong>
                  <div className="muted small">Started {formatDateTime(r.startedAt)}{r.durationSec !== null ? ` · ${r.durationSec}s` : ""}</div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className={`pill ${st.cls}`}>{st.text}</span>
                  <span className="pill neutral">{r.trigger === "backfill" ? "Backfill" : "Scheduled"}</span>
                  {r.stuck && <span className="pill bad">Appears stuck: no finish recorded</span>}
                </div>
              </div>
              {r.sources.length > 0 && (
                <ul className="chips">
                  {r.sources.map((s) => (
                    <li key={s.source} className={`chip ${s.status}`}>
                      <span className="dot" aria-hidden="true" />
                      <span><strong>{SOURCE_LABEL[s.source] ?? s.source}</strong> <span className="muted">{SRC[s.status]}</span></span>
                      <span className="count">{s.fetched} fetched · {s.accepted} relevant · {s.inserted} new{s.truncated ? " · capped" : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
              {r.sources.filter((s) => s.reason).map((s) => (
                <p key={s.source} className="small muted"><strong>{SOURCE_LABEL[s.source] ?? s.source}:</strong> {s.reason}</p>
              ))}
              <p className="small muted">
                {r.newPosts !== null && <>New posts {r.newPosts} · </>}
                {r.classified !== null && <>classified {r.classified} · </>}
                {r.unclassified ? <>{r.unclassified} awaiting classification (retried next run) · </> : null}
                Email: {r.emailStatus === "unconfirmed" ? "delivery unconfirmed (check the inbox)" : r.emailStatus ? r.emailStatus.replace("_", " ") : "–"}{r.usedFallback ? " · summary from template" : ""}
              </p>
              {r.problem && <p className="banner warn small" role="alert">{r.problem}</p>}
            </li>
          );
        })}
      </ul>
    </>
  );
}
