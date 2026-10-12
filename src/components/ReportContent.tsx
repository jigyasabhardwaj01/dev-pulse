import Link from "next/link";
import { notFound } from "next/navigation";
import CoverageAlert from "@/components/CoverageAlert";
import Donut from "@/components/Donut";
import EmptyState from "@/components/EmptyState";
import KpiCards from "@/components/KpiCards";
import MovementBadge from "@/components/MovementBadge";
import NarrativePanel from "@/components/NarrativePanel";
import AnalysisStatus from "@/components/AnalysisStatus";
import PainPointTable from "@/components/PainPointTable";
import PeriodHeader from "@/components/PeriodHeader";
import SourceCoverage, { DataNotes } from "@/components/SourceCoverage";
import TopMovers from "@/components/TopMovers";
import VolumeChart, { type VolumeRow } from "@/components/VolumeChart";
import { getReport, listReports } from "@/lib/data";
import { comparisonStatus, computeKpis, evidenceHref, previousWeekKey, readCoverage, selectMovers, shortRange, type Mover } from "@/lib/insights";
import { displayPoints } from "@/lib/report-model";
import { pct } from "@/lib/view";
import { currentSession } from "@/lib/session";
import { analysisFor } from "@/lib/analysis-source";
import { makeSupabaseStore } from "@/lib/store";
import { makeSupabaseTeamStore } from "@/lib/team-store";

/** Shortlisting needs a signed-in person AND an analysis for that week (sealed or derived); without one the control would only fail. */
async function canShortlistWeek(week: string): Promise<boolean> {
  try {
    if (!(await currentSession())) return false;
    return (await analysisFor(makeSupabaseStore(), makeSupabaseTeamStore(), week)).kind !== "none";
  } catch { return false; }
}

/** A saved report as the Overview (default) or as the full Weekly Report. Read-only: nothing here regenerates or edits a report. */
export default async function ReportContent({ week, mode = "overview" }: { week?: string; mode?: "overview" | "report" }) {
  let report = null;
  let failed = false;
  try {
    report = await getReport(week);
  } catch {
    failed = true;
  }
  if (failed) return <EmptyState title="We couldn't load the report" body="The database didn't answer, so nothing was changed or lost. Try again in a moment." action={{ href: week ? (mode === "report" ? `/reports/${week}` : `/?week=${week}`) : "/", label: "Try again" }} />;
  if (!report) {
    if (week) notFound();
    return <EmptyState title="No report yet" body="The first report is created by the weekly run. Once it has run, it appears here." action={{ href: "/status", label: "Check pipeline health" }} />;
  }

  const canShortlist = await canShortlistWeek(report.weekStart);
  // called as a function (not rendered as <AnalysisStatus/>): an async server component, resolved here so the whole report renders in one pass
  const analysisStatus = await AnalysisStatus({ week: report.weekStart });
  let volume: VolumeRow[] = [];
  try {
    volume = (await listReports()).filter((r) => r.kind === "ist").sort((a, b) => a.weekStart.localeCompare(b.weekStart))
      .map((r) => ({ week: r.weekStart, label: shortRange(r.weekStart).split(" – ")[0], mentions: r.mentions, state: r.reliability }));
  } catch {
    /* the weekly chart is optional */
  }

  const points = displayPoints(report);
  const kpis = computeKpis(points, report.stats);
  const cov = report.coverage;
  const reading = readCoverage(cov?.sources, cov?.comparison, report.reliability);
  const prevKey = previousWeekKey(report.weekStart);
  const previousLabel = prevKey ? shortRange(prevKey) : null;
  const header = <PeriodHeader report={report} mode={mode} />;
  const alert = <CoverageAlert reading={reading} usedFallback={report.usedFallback} />;
  const narrative = <NarrativePanel text={report.narrative} usedFallback={report.usedFallback} version={report.version} />;

  if (mode === "report") {
    const movers = selectMovers(points, 50);
    const List = ({ items, empty }: { items: Mover[]; empty: string }) => items.length === 0 ? <p className="muted small">{empty}</p> : (
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {items.map((m) => (
          <li key={`${m.topic_id}-${m.theme}`} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Link href={evidenceHref(m, report.weekStart)}>{m.theme}</Link>
            <span className="small muted num" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span>{m.category}</span>
              <MovementBadge item={{ direction: m.move.kind === "na" ? "unavailable" : m.move.kind, count: m.count, previous: m.previous, pct: null }} />
              <span>{m.move.counts || `${m.count} mentions`}</span>
            </span>
          </li>
        ))}
      </ul>
    );
    const top = (xs: Mover[]) => xs[0];
    const changes: string[] = [];
    if (movers.comparable) {
      const u = top(movers.increases), d = top(movers.decreases);
      if (u) changes.push(`Largest increase: ${u.theme} (${u.move.counts}, ${u.move.label}).`);
      if (movers.emerging.length) changes.push(`${movers.emerging.length} newly emerging ${movers.emerging.length === 1 ? "pain point" : "pain points"}: ${movers.emerging.slice(0, 3).map((m) => m.theme).join("; ")}${movers.emerging.length > 3 ? "…" : ""}.`);
      if (d) changes.push(`Largest decrease: ${d.theme} (${d.move.counts}, ${d.move.label}).`);
      if (!changes.length) changes.push("No pain point changed from the previous period.");
    }
    return (
      <>
        {header}
        {alert}
        {narrative}
        <section className="section" aria-labelledby="chg-heading">
          <div className="section-head"><h2 id="chg-heading">Key changes</h2><p>{comparisonStatus(report.reliability, report.weekStart).label}</p></div>
          <KpiCards kpis={kpis} />
          <div className="card card-pad">
            {movers.comparable ? <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>{changes.map((c) => <li key={c}>{c}</li>)}</ul>
              : <p className="muted">Changes are not shown for this report: {comparisonStatus(report.reliability, report.weekStart).detail}</p>}
          </div>
        </section>
        {movers.comparable && (
          <>
            <section className="section" aria-labelledby="new-heading"><h2 id="new-heading">Newly emerging pain points</h2><div className="card card-pad"><List items={movers.emerging} empty="Nothing new appeared this period." /></div></section>
            <section className="section" aria-labelledby="rd-heading">
              <h2 id="rd-heading">Rising and declining issues</h2>
              <div className="grid-eq">
                <div className="card card-pad section"><h3>Rising</h3><List items={movers.increases} empty="No pain point rose." /></div>
                <div className="card card-pad section"><h3>Declining</h3><List items={movers.decreases} empty="No pain point fell." /></div>
              </div>
            </section>
          </>
        )}
        <section className="section" aria-labelledby="un-heading">
          <div className="section-head"><h2 id="un-heading">Unresolved problems</h2><p>{kpis.unresolvedMentions} of {kpis.mentions} mentions ({pct(kpis.unresolvedShare)}) flagged unresolved</p></div>
          <div className="card card-pad"><List items={selectMovers(points, 10).unresolved} empty="No mention was flagged unresolved." /></div>
        </section>
        {analysisStatus}
        <PainPointTable canShortlist={canShortlist} points={points} weekStart={report.weekStart} />
        <section className="section" aria-labelledby="lim-heading">
          <h2 id="lim-heading">Source coverage and limitations</h2>
          <div className="grid-eq"><SourceCoverage sources={cov?.sources} /><DataNotes sources={cov?.sources} comparison={cov?.comparison} reliability={report.reliability} /></div>
        </section>
      </>
    );
  }

  return (
    <>
      {header}
      {alert}
      <div className="grid-2">
        {narrative}
        <KpiCards kpis={kpis} />
      </div>
      <TopMovers movers={selectMovers(points)} weekStart={report.weekStart} previousLabel={previousLabel} />
      {analysisStatus}
        <PainPointTable canShortlist={canShortlist} points={points} weekStart={report.weekStart} />
      <section className="section" aria-labelledby="sup-heading">
        <div className="section-head"><h2 id="sup-heading">Supporting metrics</h2></div>
        <div className="grid-eq">
          <div className="card card-pad section">
            <h3>Mentions per week</h3>
            {volume.length > 1 ? (
              <>
                <VolumeChart rows={volume} highlight={report.kind === "ist" ? report.weekStart : undefined} />
                <p className="faint small">Mentions matched to a tracked theme in each reporting week. Outlined bars had different source coverage from the week before.</p>
              </>
            ) : <p className="muted small">The weekly chart appears once there are two reports on the weekly period format.</p>}
          </div>
          <div className="card card-pad section">
            <h3>Unresolved share</h3>
            {kpis.mentions > 0
              ? <Donut part={kpis.unresolvedMentions} total={kpis.mentions} label="unresolved" partLabel="flagged unresolved" restLabel="not flagged" />
              : <p className="muted small">No mentions this period.</p>}
            <p className="faint small">Share of mentions where the post suggests the problem is still open.</p>
          </div>
        </div>
      </section>
      <section className="section" aria-labelledby="cov-heading">
        <h2 id="cov-heading" className="sr-only">Source coverage and data notes</h2>
        <div className="grid-eq"><SourceCoverage sources={cov?.sources} /><DataNotes sources={cov?.sources} comparison={cov?.comparison} reliability={report.reliability} /></div>
      </section>
    </>
  );
}
