import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/EmptyState";
import { STATE_LABEL, STATE_TONE } from "@/lib/decision-labels";
import { loadInsights } from "@/lib/insights-data";
import { compareKey, problemHref, type ProblemView } from "@/lib/insights-view";
import { currentSession } from "@/lib/session";
import { loadReview } from "@/lib/team-data";

export const metadata: Metadata = { title: "Explore & Decide" };
export const dynamic = "force-dynamic";

function Row({ p, state, mine }: { p: ProblemView; state: string | null; mine: boolean }) {
  return (
    <li className="card card-pad" style={{ display: "grid", gap: 8 }}>
      <div className="row-wrap" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 2 }}>
          <h3><Link href={problemHref(p)}>{p.theme}</Link></h3>
          <p className="muted small">{p.category} · {p.discussions} {p.discussions === 1 ? "discussion" : "discussions"} · {p.trend.label.toLowerCase()} · {p.confidence.label.toLowerCase()}</p>
        </div>
        <span className={`pill ${state ? STATE_TONE[state] : "neutral"}`}>{state ? STATE_LABEL[state] : "Not shortlisted"}</span>
      </div>
      <div className="row-wrap" style={{ justifyContent: "space-between" }}>
        <label className="check"><input type="checkbox" name="k" value={compareKey(p)} /> Compare<span className="sr-only"> {p.theme}</span></label>
        <Link className="btn" href={problemHref(p)}>{mine ? "Open and decide" : "Read the evidence"}<span className="sr-only">: {p.theme}</span></Link>
      </div>
    </li>
  );
}

export default async function Explore() {
  const session = await currentSession();
  let d, cards;
  try { [d, cards] = await Promise.all([loadInsights(), loadReview(session)]); } catch { d = null; }
  if (!d || !cards) return <EmptyState title="We couldn't load the problems" body="The database didn't answer. Nothing was changed. Try again in a moment." action={{ href: "/explore", label: "Try again" }} />;
  if (!d.report) return <EmptyState title="No report yet" body="Problems appear here after the first Friday report." action={{ href: "/", label: "Back to Insights" }} />;
  if (!d.all.length) return <EmptyState title="No problems to explore" body={d.analysis.kind === "none" ? "This report was saved before JARVIS grouped discussions into problems, so there is nothing to open yet. The next Friday report will include them." : "No recurring problem was found in this report."} action={{ href: "/", label: "Back to Insights" }} />;

  const stateOf = new Map(cards.map((c) => [`${c.view.item.topic_id}|${c.view.item.theme}`, c.view.item.state]));
  const row = (p: ProblemView) => <Row key={p.key} p={p} state={stateOf.get(compareKey(p)) ?? null} mine />;
  const decided = cards.filter((c) => ["prioritised", "parked", "rejected", "already_addressed"].includes(c.view.item.state)).length;
  return (
    <>
      <header className="hero">
        <p className="eyebrow">{d.report.periodLabel}</p>
        <h1>Explore &amp; decide</h1>
        <p className="lede">Open a problem to read the discussions behind it. Then shortlist it and record what your team will do. <strong>JARVIS only suggests</strong> what to look at; a decision is always made by a person.</p>
      </header>
      <ol className="steps" aria-label="How this works">
        <li><strong>Read</strong>: open a problem and check the original discussions.</li>
        <li><strong>Shortlist</strong>: say why it deserves your team&rsquo;s time.</li>
        <li><strong>Decide</strong>: choose to work on it, wait, or set it aside. It then appears in the <Link href="/plan">Weekly Action Plan</Link>.</li>
      </ol>
      <p className="muted small">{cards.length ? `${cards.length} shortlisted, ${decided} decided.` : "Nothing has been shortlisted yet."}</p>

      <form method="get" action="/explore/compare" className="stack">
        <input type="hidden" name="week" value={d.report.weekStart} />
        <div className="section-head">
          <h2>Suggested by JARVIS</h2>
          <button className="btn" type="submit">Compare the ones I ticked</button>
        </div>
        <p className="muted small" style={{ marginTop: -6 }}>Tick two or three problems, then press the compare button. {d.supported.length ? "These have enough evidence to be ranked." : ""}</p>
        {d.supported.length ? <ul className="problems" style={{ gap: 10 }}>{d.supported.map(row)}</ul> : <div className="explain"><strong>Nothing has enough evidence to be suggested yet.</strong><span>The early signals below are listed so you can read them yourself.</span></div>}
        {d.early.length > 0 && (
          <>
            <h2 style={{ marginTop: 10 }}>Early signals <span className="muted small">(not ranked)</span></h2>
            <ul className="problems" style={{ gap: 10 }}>{d.early.map(row)}</ul>
          </>
        )}
      </form>
    </>
  );
}
