import type { Metadata } from "next";
import Link from "next/link";
import ChartTable from "@/components/ChartTable";
import EmptyState from "@/components/EmptyState";
import ReliabilityPill from "@/components/ReliabilityPill";
import TrendChart from "@/components/TrendChart";
import VolumeChart from "@/components/VolumeChart";
import { getHistory, listReports } from "@/lib/data";
import { reportHref, shortRange } from "@/lib/insights";

export const metadata: Metadata = { title: "History" };
export const dynamic = "force-dynamic";

const count = (n: number | null, why: string) => (n === null ? <span className="faint" title={why}>–</span> : <b className="num">{n}</b>);

export default async function History() {
  let reports = null;
  let history = null;
  try { reports = await listReports(); } catch { /* handled below */ }
  try { history = await getHistory(); } catch { /* the theme chart is optional */ }

  if (!reports) return <EmptyState title="We couldn't load the history" body="The database didn't answer. Nothing was changed. Try again in a moment." action={{ href: "/history", label: "Try again" }} />;
  const ist = reports.filter((r) => r.kind === "ist");
  const legacy = reports.filter((r) => r.kind === "legacy");
  if (!reports.length) return <EmptyState title="No history yet" body="History builds up one report per week, starting with the first weekly run." action={{ href: "/status", label: "Check pipeline health" }} />;
  const volume = [...ist].sort((a, b) => a.weekStart.localeCompare(b.weekStart)).map((r) => ({ week: r.weekStart, label: shortRange(r.weekStart).split(" – ")[0], mentions: r.mentions, state: r.reliability }));

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Trends</p>
        <h1>History</h1>
        <p className="lede">How pain points moved week over week. Weeks whose source coverage differed from the week before are marked, and a dash means not compared, never zero.</p>
      </header>

      <section className="section" aria-labelledby="vol-h">
        <div className="section-head"><h2 id="vol-h">Weekly mention volume</h2><p>Mentions matched to a tracked theme</p></div>
        <div className="card chart-card">
          {volume.length > 1 ? (
            <>
              <VolumeChart rows={volume} />
              <p className="faint small">Outlined bars had different source coverage from the previous week, so a jump into or out of them may reflect coverage, not developers.</p>
            </>
          ) : <p className="muted" style={{ padding: "12px 6px" }}>Weekly volume needs at least two reports on the weekly period format. {volume.length === 1 ? `So far: ${volume[0].mentions} mentions in the week of ${volume[0].label}.` : ""}</p>}
        </div>
      </section>

      <section className="section" aria-labelledby="cmp-h">
        <div className="section-head"><h2 id="cmp-h">Week-over-week comparison</h2><p>Newly emerging, rising and declining pain points per report</p></div>
        {ist.length ? (
          <ul className="report-cards">
            {ist.map((r) => (
              <li key={r.weekStart} className="card report-card">
                <div className="rc-title">
                  <strong>{r.periodLabel}</strong>
                  <span className="chips-row" style={{ gap: 6 }}><ReliabilityPill value={r.reliability} />{r.version ? <span className="faint small">v{r.version}</span> : null}</span>
                </div>
                <div className="rc-stats">
                  <div className="rc-stat"><b className="num">{r.mentions}</b><span>Mentions</span></div>
                  <div className="rc-stat">{count(r.emerging, "Not compared")}<span>New</span></div>
                  <div className="rc-stat">{count(r.rising, "Not compared")}<span>Rising</span></div>
                  <div className="rc-stat">{count(r.declining, "Not compared")}<span>Declining</span></div>
                </div>
                <div className="rc-open"><Link className="btn" href={reportHref(r.weekStart)}>Open report<span className="sr-only"> for {r.periodLabel}</span></Link></div>
              </li>
            ))}
          </ul>
        ) : <div className="card empty"><p className="muted">No reports on the weekly period format yet.</p></div>}
      </section>

      {history && history.rows.length > 0 && (
        <section className="section" aria-labelledby="th-h">
          <div className="section-head"><h2 id="th-h">Theme movement</h2><p>Mentions per pain point, by reporting week</p></div>
          {history.legacyOnly && <div className="alert info" role="note"><p><strong>Earlier-format weeks only. </strong>These were recorded before source coverage was tracked, so lines between them may reflect a different source mix rather than real change.</p></div>}
          {history.rows.length > 1 ? (
            <>
              <TrendChart series={history.series} rows={history.rows} />
              <ChartTable series={history.series} rows={history.rows} />
            </>
          ) : <div className="card card-pad muted">Theme lines need at least two weeks. The first week recorded is {history.rows[0].label}.</div>}
        </section>
      )}

      {legacy.length > 0 && (
        <section className="section" aria-labelledby="lg-h">
          <div className="section-head"><h2 id="lg-h">Earlier-format weeks</h2><p>Not charted or compared with the weeks above</p></div>
          <ul className="report-cards">
            {legacy.map((r) => (
              <li key={r.weekStart} className="card report-card">
                <div className="rc-title"><strong>{r.periodLabel}</strong><span className="muted small">Source coverage was not recorded for this week.</span></div>
                <div className="rc-stats"><div className="rc-stat"><b className="num">{r.mentions}</b><span>Mentions</span></div><div className="rc-stat"><b className="num">{r.painPoints}</b><span>Pain points</span></div></div>
                <div className="rc-open"><Link className="btn" href={reportHref(r.weekStart)}>Open report<span className="sr-only"> for {r.periodLabel}</span></Link></div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
