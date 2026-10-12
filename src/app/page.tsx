import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/EmptyState";
import ProblemCard from "@/components/ProblemCard";
import FridayCard from "@/components/FridayCard";
import StatusStrip from "@/components/StatusStrip";
import { fridayStatus } from "@/lib/friday-status";
import { loadInsights } from "@/lib/insights-data";
import { problemHref } from "@/lib/insights-view";
import { readSchedule } from "@/lib/schedule";
import { aiStatus, collectionStatus } from "@/lib/status-plain";
import vercelConfig from "../../vercel.json";
import { requireKnownWeek } from "@/lib/page-guard";
import { formatDateTime } from "@/lib/view";

export const metadata: Metadata = { title: "Insights" };
export const dynamic = "force-dynamic";

export default async function Insights({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { week } = await searchParams;
  await requireKnownWeek(week);
  let d;
  try { d = await loadInsights(week); } catch { d = null; }
  if (!d) return <EmptyState title="We couldn't load this week's insights" body="The database didn't answer, so nothing is shown rather than something wrong. Nothing was changed. Try again in a moment." action={{ href: "/", label: "Try again" }} />;
  const { report, run, supported, early, analysis } = d;
  if (!report) return <EmptyState title="No report yet" body="JARVIS builds its first report on Friday morning (IST). Until then there is nothing to show, and nothing is made up." action={{ href: "/settings", label: "See what JARVIS watches" }} />;

  const env = process.env;
  const friday = fridayStatus({
    now: new Date(), report, runs: d.runs,
    setup: { schedule: readSchedule(vercelConfig), aiKey: Boolean(env.OPENROUTER_API_KEY), emailKey: Boolean(env.RESEND_API_KEY), recipient: env.DIGEST_TO_EMAIL ?? null, cronSecret: Boolean(env.CRON_SECRET) },
  });
  const growing = d.all.filter((p) => p.trend.kind === "increasing" || p.trend.kind === "new").slice(0, 5);
  const checkedAt = run ? `Last checked ${formatDateTime(run.finishedAt ?? run.startedAt)}.` : undefined;
  return (
    <>
      <header className="hero">
        <p className="eyebrow">This week · {report.periodLabel}</p>
        <h1>What developers are struggling with</h1>
        <p className="lede">JARVIS reads public developer discussions, groups the ones about the same problem, and shows the problems with the most evidence behind them.</p>
      </header>

      <StatusStrip items={[
        { k: "New discussions", s: collectionStatus(run), when: checkedAt },
        { k: "AI analysis", s: aiStatus(run, report) },
      ]} />
      <FridayCard s={friday} />
      {!d.runKnown && <p className="alert warn" role="status"><span>Run history could not be read, so freshness and AI status are unknown right now.</span></p>}

      {report.narrative && (
        <section className="card summary" aria-labelledby="sum-h">
          <h2 id="sum-h">In short</h2>
          <p>{report.narrative}</p>
          <p className="muted small">{report.usedFallback ? "Written from a standard template because the AI summary was not available. The numbers below are not affected." : "Written by AI from the saved numbers."}</p>
        </section>
      )}

      <section className="stack" aria-labelledby="top-h">
        <div className="section-head"><h2 id="top-h">Top problems this week</h2><p>{supported.length ? `${supported.length} with enough evidence to rank` : "None has enough evidence to rank yet"}</p></div>
        {analysis.kind === "none" ? (
          <div className="explain"><strong>This report has no problem analysis.</strong><span>It was saved before JARVIS grouped discussions into problems. The next Friday report will include one. You can also build one from the stored discussions in Settings &amp; Diagnostics → Past reports.</span></div>
        ) : supported.length ? (
          <ol className="problems">{supported.map((p) => <ProblemCard key={p.key} p={p} />)}</ol>
        ) : (
          <div className="explain"><strong>No problem has enough evidence to be ranked.</strong><span>A problem is ranked only when at least two separate discussions mention it and one quote could be checked against the original. {early.length ? `${early.length} early signals are listed below so you can look at them yourself.` : ""}</span></div>
        )}
      </section>

      <section className="stack" aria-labelledby="up-h">
        <div className="section-head"><h2 id="up-h">Becoming more common</h2></div>
        {growing.length ? (
          <ul className="problems" style={{ gap: 10 }}>
            {growing.map((p) => <li key={p.key} className="card card-pad" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}><span><strong>{p.theme}</strong><span className="muted small" style={{ display: "block" }}>{p.trend.detail}{p.supported ? "" : " Early signal."}</span></span><Link className="btn" href={problemHref(p)}>Look at the evidence<span className="sr-only">: {p.theme}</span></Link></li>)}
          </ul>
        ) : (
          <div className="explain"><span>{d.all.some((p) => p.trend.kind !== "unknown") ? "No problem is clearly increasing this week." : "Not enough comparable data to say what is increasing. Last week's data is missing or was collected differently, so no rise or fall is claimed."}</span></div>
        )}
      </section>

      {early.length > 0 && (
        <section className="stack" aria-labelledby="early-h">
          <div className="section-head"><h2 id="early-h">Early signals</h2><p>Not ranked: too little evidence so far</p></div>
          <ul className="problems" style={{ gap: 10 }}>
            {early.slice(0, 6).map((p) => (
              <li key={p.key} className="card card-pad" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <span><strong>{p.theme}</strong><span className="muted small" style={{ display: "block" }}>{p.category} · {p.discussions} {p.discussions === 1 ? "discussion" : "discussions"} · {p.confidence.label.toLowerCase()}</span></span>
                <Link className="btn" href={problemHref(p)}>Look at the evidence<span className="sr-only">: {p.theme}</span></Link>
              </li>
            ))}
          </ul>
          {early.length > 6 && <p className="muted small">{early.length - 6} more are listed in <Link href="/explore">Explore &amp; Decide</Link>.</p>}
        </section>
      )}

      {d.limitations.length > 0 && (
        <details className="card card-pad">
          <summary>Things to keep in mind ({d.limitations.length})</summary>
          <ul className="steps" style={{ marginTop: 10 }}>{d.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </details>
      )}

      <section className="explain" aria-label="What to do next">
        <strong>What you can do next</strong>
        <span>Open a problem to read the original discussions, shortlist it, and record whether your team will work on it. Your choices appear in the <Link href="/plan">Weekly Action Plan</Link>.</span>
      </section>
    </>
  );
}
