import { ago, HEALTH_RULES, scheduleText, type Health, type Level } from "@/lib/health";
import type { ScheduleState } from "@/lib/schedule";
import { formatDateTime } from "@/lib/view";
import { Icon } from "./Icons";

const OUTCOME: Record<string, string> = { succeeded: "Succeeded", partial: "Completed with issues", failed: "Failed", running: "Running" };
const ICON: Record<Level, "check" | "alert" | "info"> = { ok: "check", degraded: "alert", attention: "alert", unknown: "info" };
const LEVEL_WORD: Record<Level, string> = { ok: "Working", degraded: "Gaps", attention: "Action needed", unknown: "Unknown" };

/** The five questions at a glance: is it working, when did it last succeed, what is wrong, what is incomplete, does anyone need to act. */
export default function HealthSummary({ health, schedule, now }: { health: Health; schedule: ScheduleState; now: Date }) {
  const { latest, lastSuccessful, lastCompleted, tally } = health;
  const sched = scheduleText(schedule, now);
  const shown = health.reasons.filter((r) => r.level !== "note");
  const notes = health.reasons.filter((r) => r.level === "note");
  const outcome = latest ? (OUTCOME[latest.status] ?? "Unknown status") : "No runs";
  return (
    <section className={`card health hs-${health.level}`} aria-labelledby="health-heading">
      <div className="health-main">
        <p className="eyebrow">Overall</p>
        <h2 id="health-heading" className="health-title"><Icon name={ICON[health.level]} size={22} /><span>{health.headline}</span><span className="sr-only"> ({LEVEL_WORD[health.level]})</span></h2>
        <p className="health-summary">{health.summary}</p>
        {shown.length > 1 && (
          <ul className="health-reasons">
            {shown.slice(1).map((r) => <li key={r.text}>{r.text}</li>)}
          </ul>
        )}
        {notes.length > 0 && <ul className="health-notes">{notes.map((r) => <li key={r.text}>{r.text}</li>)}</ul>}
      </div>
      <dl className="health-facts">
        <div>
          <dt>Latest run</dt>
          <dd><strong>{outcome}</strong>{latest && <><br /><span className="muted small">{latest.trigger === "backfill" ? "Backfill" : "Scheduled"} · {ago(latest.startedAt, now)}<br />{formatDateTime(latest.startedAt)}</span></>}</dd>
        </div>
        <div>
          <dt>Last successful run</dt>
          <dd>
            {lastSuccessful ? <><strong>{ago(lastSuccessful.finishedAt ?? lastSuccessful.startedAt, now)}</strong><br /><span className="muted small">{formatDateTime(lastSuccessful.finishedAt ?? lastSuccessful.startedAt)}</span></>
              : <><strong>None recorded</strong><br /><span className="muted small">{lastCompleted ? `Last completed with issues ${ago(lastCompleted.finishedAt, now)}` : "No run has finished"}</span></>}
          </dd>
        </div>
        <div>
          <dt>Sources in the latest run</dt>
          <dd>
            <strong>{tally.clean} clean</strong>
            <br /><span className="muted small">{tally.partial} partial · {tally.failed} failed{tally.notChecked + tally.unknown ? ` · ${tally.notChecked + tally.unknown} unchecked` : ""}</span>
          </dd>
        </div>
        <div>
          <dt>Scheduled runs</dt>
          <dd><strong>{sched.label}</strong><br /><span className="muted small">{sched.detail}</span>{sched.next && <><br /><span className="small">Next due: <strong>{formatDateTime(sched.next.toISOString())}</strong></span></>}</dd>
        </div>
      </dl>
      <details className="health-rules">
        <summary>How health is decided</summary>
        <ul>{HEALTH_RULES.map((r) => <li key={r}>{r}</li>)}</ul>
        <p className="faint small">Source of truth: the pipeline_runs and source_fetches records, and the deployed vercel.json for the schedule. Inbox delivery of email is not observable here.</p>
      </details>
    </section>
  );
}
