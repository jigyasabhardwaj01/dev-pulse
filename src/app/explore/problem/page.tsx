import type { Metadata } from "next";
import PageArt from "@/components/motion/PageArt";
import Link from "next/link";
import { notFound } from "next/navigation";
import EmptyState from "@/components/EmptyState";
import { EvidenceList } from "@/components/ProblemCard";
import { DecisionForm, RemoveButton, ShortlistForm, VotePanel } from "@/components/ProblemActions";
import { OUTCOME_LABEL } from "@/lib/decision-labels";
import { loadProblem } from "@/lib/insights-data";
import { sourceName } from "@/lib/insights-view";
import { currentSession } from "@/lib/session";
import { makeSupabaseTeamStore } from "@/lib/team-store";
import { viewItem } from "@/lib/team";
import { formatDateTime } from "@/lib/view";

export const metadata: Metadata = { title: "Problem" };
export const dynamic = "force-dynamic";

const TRIM = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

export default async function ProblemPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { week, topic, theme } = await searchParams;
  if (!week || !topic || !theme || !/^\d{4}-\d{2}-\d{2}$/.test(week)) notFound();
  const session = await currentSession();
  let data, card = null;
  try {
    data = await loadProblem(week, topic, theme);
    if (data.kind === "ok") {
      const team = makeSupabaseTeamStore();
      const item = (await team.listItems()).find((i) => i.topic_id === topic && i.theme === theme && i.state !== "withdrawn");
      card = item ? await viewItem(team, session, item) : null;
    }
  } catch { data = null; }
  if (!data) return <EmptyState title="We couldn't load this problem" body="The database didn't answer. Nothing was changed. Try again in a moment." action={{ href: "/explore", label: "Back to the list" }} />;
  if (data.kind === "no_analysis") return <EmptyState title="This report has no problem analysis" body="It was saved before JARVIS grouped discussions into problems." action={{ href: "/explore", label: "Back to the list" }} />;
  if (data.kind === "not_found") notFound();

  const { problem: p, posts, postsFailed } = data;
  const decided = card?.current ?? null;
  return (
    <>
      <p className="small"><Link href="/explore">← All problems</Link></p>
      <header className="hero">
        <PageArt shape="globe" />
        <p className="eyebrow">{p.category}</p>
        <h1 style={{ maxWidth: "32ch" }}>{p.theme}</h1>
        <p className="lede">{p.whyItMatters}</p>
      </header>

      <section className="who-box" aria-labelledby="sug-h">
        <div className="row-wrap" style={{ gap: 8 }}><span className="tag ai">Suggested by JARVIS</span><h2 id="sug-h" style={{ fontSize: "1rem" }}>{p.rank ? `Ranked number ${p.rank} this week` : p.supported ? "Has enough evidence to be ranked" : "Not ranked: early signal"}</h2></div>
        <dl className="facts">
          <div><dt>Who runs into it</dt><dd>{p.who}</dd></div>
          <div><dt>Separate discussions</dt><dd>{p.discussions}<small>{p.sources.join(", ")}</small></dd></div>
          <div><dt>Compared with last week</dt><dd>{p.trend.label}<small>{p.trend.detail}</small></dd></div>
          <div><dt>How sure are we</dt><dd>{p.confidence.label}<small>{p.confidence.detail}</small></dd></div>
        </dl>
        {p.notRankedBecause && <p className="muted small">{p.notRankedBecause}</p>}
        <p className="muted small">This is a suggestion from the numbers. It is not a decision.</p>
      </section>

      <section className="stack" aria-labelledby="ev-h">
        <h2 id="ev-h">Evidence: what people actually wrote</h2>
        <div className="card card-pad"><EvidenceList links={p.evidence} max={5} /></div>
        <h3>Every post found ({posts.length})</h3>
        <p className="muted small" style={{ marginTop: -6 }}>Several posts can belong to the same thread. A thread counts as one discussion in the numbers above.</p>
        {postsFailed ? <p className="alert warn">The full list could not be loaded. The quotes above are still accurate.</p>
          : posts.length === 0 ? <p className="muted">No stored discussions were found for this period.</p> : (
            <ul className="evidence card card-pad" style={{ gap: 12 }}>
              {posts.slice(0, 25).map((x) => (
                <li key={x.id}>
                  {x.url ? <a href={x.url} target="_blank" rel="noopener noreferrer">{TRIM(x.title, 140)}<span className="sr-only"> (opens in a new tab)</span></a> : <span>{TRIM(x.title, 140)}</span>}
                  <span className="src">{sourceName(x.source)} · {formatDateTime(x.posted_at)}{x.unresolved ? " · looks unresolved" : ""}</span>
                </li>
              ))}
            </ul>
          )}
        {posts.length > 25 && <p className="muted small">Showing the newest 25 of {posts.length}.</p>}
      </section>

      <section className="stack" aria-labelledby="dec-h">
        <div className="row-wrap" style={{ gap: 8 }}><span className="tag team">Your team decides</span><h2 id="dec-h">Decision</h2></div>
        {decided && (
          <div className="who-box">
            <h3>{OUTCOME_LABEL[decided.outcome]}</h3>
            <p>&ldquo;{decided.rationale}&rdquo;</p>
            <p className="muted small">Recorded {formatDateTime(decided.decided_at)}{decided.followup ? " · needs a follow-up" : ""}. It appears in the <Link href="/plan">Weekly Action Plan</Link>.</p>
            {card && card.history.length > 0 && <details><summary className="small">Earlier decisions ({card.history.length})</summary><ul className="steps">{card.history.map((h) => <li key={h.id}>{formatDateTime(h.decided_at)}: {OUTCOME_LABEL[h.outcome]} — “{h.rationale}” (replaced)</li>)}</ul></details>}
          </div>
        )}
        {!card ? (
          <div className="who-box"><h3>Step 1: shortlist it</h3><ShortlistForm weekStart={p.week} topicId={p.topicId} theme={p.theme} /></div>
        ) : (
          <>
            {card.item.reason && <p className="muted small">Shortlisted because: “{card.item.reason}”</p>}
            <div className="who-box"><h3>{decided ? "Change the decision" : "Step 2: record a decision"}</h3><DecisionForm itemId={card.item.id} current={decided?.outcome ?? null} /></div>
            <div className="who-box"><h3>Advice from teammates (optional)</h3><VotePanel itemId={card.item.id} open={card.item.state === "open_for_votes"} mine={card.mine} tally={card.tally} /></div>
            {!decided && <RemoveButton itemId={card.item.id} />}
          </>
        )}
      </section>
      <p className="muted small"><Link href="/explore">← All problems</Link> · <Link href="/plan">Weekly Action Plan →</Link></p>
    </>
  );
}
