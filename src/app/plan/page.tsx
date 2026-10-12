import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/EmptyState";
import PrintButton from "@/components/PrintButton";
import { OUTCOME_LABEL } from "@/lib/decision-labels";
import { problemHref } from "@/lib/insights-view";
import { loadPlan, type PlanItem } from "@/lib/plan-data";
import { currentSession } from "@/lib/session";
import { formatDateTime } from "@/lib/view";

export const metadata: Metadata = { title: "Weekly Action Plan" };
export const dynamic = "force-dynamic";

function Item({ i }: { i: PlanItem }) {
  const href = i.week ? problemHref({ week: i.week, topicId: i.topicId, theme: i.theme }) : "/explore";
  return (
    <li className="card problem" aria-label={i.theme}>
      <div className="stack" style={{ gap: 4 }}>
        <h3><Link href={href}>{i.theme}</Link></h3>
        <p className="cat">{i.category}{i.discussions !== null ? ` · ${i.discussions} separate discussions in the report` : ""}</p>
      </div>
      <dl className="facts">
        <div><dt>Why it was selected</dt><dd>{i.why ? `“${i.why}”` : "No reason was recorded."}</dd></div>
        <div><dt>Team decision</dt><dd>{i.outcome ? <><span className="tag team">{OUTCOME_LABEL[i.outcome]}</span>{i.rationale && <small>“{i.rationale}”{i.decidedAt ? ` · ${formatDateTime(i.decidedAt)}` : ""}</small>}</> : "No decision yet"}</dd></div>
        <div><dt>Suggested next step</dt><dd>{i.nextStep}<small>Generated suggestion. Nobody has agreed to it.</small></dd></div>
      </dl>
    </li>
  );
}

export default async function Plan() {
  let plan;
  try { plan = await loadPlan(await currentSession()); } catch { plan = null; }
  if (!plan) return <EmptyState title="We couldn't load the plan" body="The database didn't answer. Nothing was changed. Try again in a moment." action={{ href: "/plan", label: "Try again" }} />;
  const nothing = !plan.focus.length && !plan.considering.length && !plan.notNow.length;
  return (
    <>
      <header className="hero">
        <p className="eyebrow">{plan.periodLabel ? `Based on the report for ${plan.periodLabel}` : "No report yet"}</p>
        <h1>Weekly action plan</h1>
        <p className="lede">The problems your team picked to look into, why they were picked, and what was decided. It updates as soon as a decision is recorded.</p>
        <div className="actions">
          <a className="btn primary" href="/api/plan/export" download>Download the plan</a>
          <PrintButton />
          {plan.week && <Link className="btn" href={`/reports/${plan.week}`}>Read the full weekly report</Link>}
        </div>
      </header>

      {plan.summary && (
        <section className="card summary" aria-labelledby="s-h">
          <h2 id="s-h">The week in short</h2>
          <p>{plan.summary}</p>
          <p className="muted small">{plan.summaryIsTemplate ? "Written from a standard template, not by the AI." : "Written by AI from the saved numbers."}</p>
        </section>
      )}

      {nothing ? (
        <EmptyState title="Nothing has been chosen yet" body="Open a problem, shortlist it, and record a decision. It will appear here." action={{ href: "/explore", label: "Explore & decide" }} />
      ) : (
        <>
          <section className="stack" aria-labelledby="f-h">
            <h2 id="f-h">Work on this ({plan.focus.length})</h2>
            {plan.focus.length ? <ul className="problems">{plan.focus.map((i) => <Item key={i.itemId} i={i} />)}</ul> : <p className="muted">Nothing has been chosen for the coming week yet.</p>}
          </section>
          {plan.considering.length > 0 && (
            <section className="stack" aria-labelledby="c-h"><h2 id="c-h">Waiting for a decision ({plan.considering.length})</h2><ul className="problems">{plan.considering.map((i) => <Item key={i.itemId} i={i} />)}</ul></section>
          )}
          {plan.notNow.length > 0 && (
            <section className="stack" aria-labelledby="n-h"><h2 id="n-h">Set aside ({plan.notNow.length})</h2><ul className="problems">{plan.notNow.map((i) => <Item key={i.itemId} i={i} />)}</ul></section>
          )}
        </>
      )}

      {plan.suggested.length > 0 && (
        <section className="stack" aria-labelledby="g-h">
          <div className="section-head"><h2 id="g-h">JARVIS suggests looking at</h2><p>Not chosen by anyone yet</p></div>
          <ul className="problems" style={{ gap: 10 }}>
            {plan.suggested.map((p) => (
              <li key={p.key} className="card card-pad" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <span><strong>{p.theme}</strong><span className="muted small" style={{ display: "block" }}>{p.discussions} separate discussions · {p.confidence.label.toLowerCase()}</span></span>
                <Link className="btn" href={problemHref(p)}>Read and decide<span className="sr-only">: {p.theme}</span></Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
