import type { FridayStatus } from "@/lib/friday-status";

/** The six questions about the Friday email, answered in plain words from real configuration and recorded runs. */
export default function FridayCard({ s }: { s: FridayStatus }) {
  const item = (k: string, tone: string, head: string, body: string) => (
    <div className="status-item" key={k}><span className="k">{k}</span><strong><span className={`dot ${tone}`} aria-hidden="true" />{head}</strong><p>{body}</p></div>
  );
  return (
    <section className="card friday" aria-labelledby="fri-h">
      <div className="stack" style={{ gap: 4 }}>
        <h2 id="fri-h">Your Friday email</h2>
        <p className="muted small">Will it arrive by itself? You never have to press anything.</p>
      </div>
      <div className={`verdict ${s.verdict.tone}`} role="status"><strong>{s.verdict.headline}</strong><span>{s.verdict.detail}</span></div>
      <div className="status-strip">
        {item("Next email", s.next.when ? "ok" : "bad", s.next.label, s.next.when ? `It covers ${s.next.period}. Goes to ${s.next.recipient}. Vercel may start it up to an hour late.` : "No weekly run is scheduled.")}
        {item("Last run", s.lastRun.tone, s.lastRun.headline, s.lastRun.detail)}
        {item("Last report", s.lastReport.tone, s.lastReport.headline, s.lastReport.detail)}
        {item("Last email", s.lastEmail.tone, s.lastEmail.headline, s.lastEmail.detail)}
      </div>
      <div className={`action ${s.actions.length ? "needed" : ""}`}>
        <strong>Action required</strong>
        {s.actions.length ? <ul>{s.actions.map((a) => <li key={a}>{a}</li>)}</ul> : <span>Nothing. You do not need to do anything.</span>}
      </div>
      <p className="muted small">There is no button that sends the weekly email. A practice (&ldquo;rehearsal&rdquo;) email can be sent by a maintainer from a script; it is labelled [Rehearsal] and never counts as the real delivery.</p>
    </section>
  );
}
