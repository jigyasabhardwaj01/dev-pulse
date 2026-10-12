import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/EmptyState";
import { OwnerControls, VoteControls, WithdrawButton } from "@/components/ReviewControls";
import { currentSession } from "@/lib/session";
import { loadReview, type ReviewCard } from "@/lib/team-data";
import { formatDateTime } from "@/lib/view";

export const metadata: Metadata = { title: "Review & Decisions" };
export const dynamic = "force-dynamic";

const STATE: Record<string, { label: string; cls: string }> = {
  under_review: { label: "Under review", cls: "neutral" }, open_for_votes: { label: "Open for votes", cls: "info" }, prioritised: { label: "Prioritised", cls: "ok" },
  parked: { label: "Parked", cls: "warn" }, rejected: { label: "Rejected", cls: "bad" }, already_addressed: { label: "Already addressed", cls: "neutral" }, withdrawn: { label: "Withdrawn", cls: "neutral" },
};
const GROUPS: { title: string; states: string[] }[] = [
  { title: "Needs attention", states: ["under_review", "open_for_votes"] },
  { title: "Decided", states: ["prioritised", "parked", "rejected", "already_addressed"] },
  { title: "Withdrawn", states: ["withdrawn"] },
];

function Card({ c, role, email }: { c: ReviewCard; role: "owner" | "member"; email: string }) {
  const { item, tally, mine, current, history, voters } = c.view;
  const st = STATE[item.state];
  return (
    <li className="card review-item" aria-label={item.theme}>
      <div className="row-wrap" style={{ justifyContent: "space-between" }}>
        <h3>{item.theme}</h3>
        <span className={`pill ${st.cls}`}>{st.label}</span>
      </div>
      <p className="muted small" style={{ margin: 0 }}>{c.topicName} · first shortlisted from week of {item.first_week ?? "unknown"} · by {item.created_by}</p>
      {item.reason && <p style={{ margin: 0 }}><span className="muted small">Why it was shortlisted: </span>{item.reason}</p>}

      <dl className="stack-sm" style={{ margin: 0 }}>
        <div><dt className="small muted">AI ranking (from the saved report)</dt>
          <dd style={{ margin: 0 }}>{c.ai.discussions === null ? "Not found in that week's saved analysis." : c.ai.rank ? `Ranked #${c.ai.rank} of the top 3 (${c.ai.discussions} discussions).` : `Not in the top 3 (${c.ai.discussions} discussions).`}{" "}
            {item.first_week && <Link href={`/posts?topic=${item.topic_id}&theme=${encodeURIComponent(item.theme)}&week=${item.first_week}`}>See the evidence →</Link>}</dd></div>
        <div><dt className="small muted">Team votes (advice only)</dt>
          <dd style={{ margin: 0 }}><span className="tally"><span>Prioritise {tally.prioritise}</span><span>Park {tally.park}</span><span className="muted">{tally.total} total</span></span>
            {voters && voters.length > 0 && <span className="muted small" style={{ display: "block" }}>{voters.map((v) => `${v.voter}: ${v.choice}`).join(" · ")}</span>}</dd></div>
        <div><dt className="small muted">Owner decision</dt>
          <dd style={{ margin: 0 }}>{current ? <><strong>{STATE[current.outcome].label}</strong> by {current.decided_by}, {formatDateTime(current.decided_at)}. “{current.rationale}”{current.followup ? <span className="pill info" style={{ marginLeft: 6 }}>Follow-up needed</span> : null}{current.vote_snapshot && <span className="muted small" style={{ display: "block" }}>Votes at the time: prioritise {current.vote_snapshot.prioritise}, park {current.vote_snapshot.park}.</span>}</> : <span className="muted">No decision yet.</span>}</dd></div>
      </dl>

      {history.length > 0 && (
        <details><summary className="small">Earlier decisions ({history.length})</summary>
          <ul className="history-list">{history.map((h) => <li key={h.id}>{formatDateTime(h.decided_at)} · {STATE[h.outcome].label} by {h.decided_by}: “{h.rationale}” (superseded)</li>)}</ul></details>
      )}
      {(role === "owner" || item.created_by === email) && ["under_review", "open_for_votes"].includes(item.state) && !current && <WithdrawButton itemId={item.id} theme={item.theme} />}
      {item.state === "open_for_votes" && <VoteControls itemId={item.id} mine={mine} />}
      {role === "owner" && item.state !== "withdrawn" && <OwnerControls itemId={item.id} state={item.state} />}
    </li>
  );
}

export default async function Review() {
  const session = await currentSession();
  if (!session) return <EmptyState title="Sign in to review" body="Shortlists, votes and decisions are for the named team. Reports and evidence stay open to read." action={{ href: "/signin", label: "Sign in" }} />;
  let cards: ReviewCard[] | null;
  try { cards = await loadReview(session); } catch { cards = null; }
  if (!cards) return <EmptyState title="We couldn't load the review list" body="The database didn't answer. Nothing was changed. Reload in a moment." action={{ href: "/review", label: "Reload" }} />;
  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Team · signed in as {session.email} ({session.role})</p>
        <h1>Review &amp; Decisions</h1>
        <p className="lede">Anyone on the team can shortlist a pain point from a report, with a reason. The owner opens voting and records the final decision. Votes inform the owner; they never decide. Every step is recorded.</p>
        <div className="chips-row">
          <Link className="btn" href="/reports">Shortlist from a report</Link>
          <Link className="btn" href="/pack">Monday pack</Link>
          <form method="post" action="/api/auth/signout"><button className="btn" type="submit">Sign out</button></form>
        </div>
      </header>
      {cards.length === 0 && <EmptyState title="Nothing shortlisted yet" body="Open a weekly report and use Shortlist on a pain point worth the team's time." action={{ href: "/reports", label: "Open reports" }} />}
      {GROUPS.map((g) => {
        const list = cards!.filter((c) => g.states.includes(c.view.item.state));
        return list.length ? (
          <section key={g.title} className="section" aria-label={g.title}>
            <h2>{g.title} <span className="muted small">({list.length})</span></h2>
            <ul className="review-grid" style={{ listStyle: "none", margin: 0, padding: 0 }}>{list.map((c) => <Card key={c.view.item.id} c={c} role={session.role} email={session.email} />)}</ul>
          </section>
        ) : null;
      })}
    </>
  );
}
