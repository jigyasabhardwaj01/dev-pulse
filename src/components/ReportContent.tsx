import { notFound } from "next/navigation";
import ChartTable from "@/components/ChartTable";
import DataQuality from "@/components/DataQuality";
import EmptyState from "@/components/EmptyState";
import PainPointGroups from "@/components/PainPointGroups";
import ReportHeader from "@/components/ReportHeader";
import SourceHealth from "@/components/SourceHealth";
import StatTiles from "@/components/StatTiles";
import TrendChart from "@/components/TrendChart";
import { getHistory, getReport } from "@/lib/data";
import { displayPoints } from "@/lib/report-model";

/** One saved report: summary, data-quality notes, totals, sources, pain points and the history chart. */
export default async function ReportContent({ week }: { week?: string }) {
  let report = null;
  let failed = false;
  try {
    report = await getReport(week);
  } catch {
    failed = true;
  }
  if (failed) return <EmptyState title="We couldn't load the report" body="The database didn't answer. Nothing is lost; try again in a moment." action={{ href: "/", label: "Try again" }} />;
  if (!report) {
    if (week) notFound();
    return <EmptyState title="No report yet" body="The first report is created by the Friday run. Once it has run, it appears here." />;
  }

  let history = null;
  try {
    history = await getHistory();
  } catch {
    /* the chart is optional */
  }

  return (
    <>
      <ReportHeader report={report} />
      <section className="card summary" aria-labelledby="sum-heading">
        <h2 id="sum-heading" className="eyebrow" style={{ fontSize: ".75rem" }}>Summary</h2>
        <p>{report.narrative}</p>
      </section>
      <DataQuality reliability={report.reliability} comparison={report.coverage?.comparison ?? null} usedFallback={report.usedFallback} />
      <StatTiles stats={report.stats} showSources={report.coverage !== null} />
      <SourceHealth sources={report.coverage?.sources} />
      <PainPointGroups points={displayPoints(report)} weekStart={report.weekStart} />
      {history && history.rows.length > 1 && (
        <section style={{ display: "grid", gap: 12 }} aria-labelledby="hist-heading">
          <h2 id="hist-heading">Mentions over time</h2>
          <TrendChart series={history.series} rows={history.rows} />
          <ChartTable series={history.series} rows={history.rows} />
        </section>
      )}
    </>
  );
}
