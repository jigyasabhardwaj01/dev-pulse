import type { Metadata } from "next";
import Link from "next/link";
import ChartTable from "@/components/ChartTable";
import EmptyState from "@/components/EmptyState";
import ReliabilityPill from "@/components/ReliabilityPill";
import TrendChart from "@/components/TrendChart";
import { getHistory, listReports } from "@/lib/data";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

const DELIVERY: Record<string, string> = { sent: "Emailed", sending: "Sending", failed: "Failed", not_sent: "Not emailed", unknown: "–" };

export default async function History() {
  let reports = null;
  let history = null;
  try { reports = await listReports(); } catch { /* handled below */ }
  try { history = await getHistory(); } catch { /* chart is optional */ }

  if (!reports) return <EmptyState title="We couldn't load the reports" body="The database didn't answer. Try again in a moment." action={{ href: "/history", label: "Try again" }} />;
  if (!reports.length) return <EmptyState title="No reports yet" body="Reports appear here after the first Friday run." />;

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Archive</p>
        <h1>All weekly reports</h1>
        <p className="muted">Each report covers seven complete IST days. &ldquo;Trends withheld&rdquo; means source coverage differed from the week before, so changes would not have been reliable.</p>
      </header>

      <section className="card" style={{ padding: 18 }} aria-labelledby="rep-heading">
        <h2 id="rep-heading" className="sr-only">Report list</h2>
        <div className="table-wrap">
          <table>
            <caption>Newest first</caption>
            <thead>
              <tr>
                <th scope="col">Period</th><th scope="col" className="num">Mentions</th><th scope="col" className="num">Pain points</th>
                <th scope="col" className="num">Sources healthy</th><th scope="col">Trends</th><th scope="col">Email</th><th scope="col"><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.weekStart}>
                  <th scope="row" style={{ fontWeight: 600, textTransform: "none", letterSpacing: 0, fontSize: ".92rem", color: "var(--text)" }}>
                    {r.periodLabel}{r.version ? <span className="muted small"> · v{r.version}</span> : null}
                  </th>
                  <td className="num">{r.mentions}</td>
                  <td className="num">{r.painPoints}</td>
                  <td className="num">{r.sourcesTotal ? `${r.sourcesOk}/${r.sourcesTotal}` : "–"}</td>
                  <td><ReliabilityPill value={r.reliability} /></td>
                  <td className="small">{DELIVERY[r.delivery]}</td>
                  <td><Link href={`/?week=${r.weekStart}`}>Open<span className="sr-only"> report for {r.periodLabel}</span></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {history && history.rows.length > 0 && (
        <section style={{ display: "grid", gap: 12 }} aria-labelledby="chart-heading">
          <h2 id="chart-heading">Mentions per pain point</h2>
          {history.legacyOnly && (
            <div className="banner info" role="note"><span><span className="tag">Earlier-format weeks only.</span> These were recorded before source coverage was tracked, so lines between them may reflect a different mix of sources rather than real change.</span></div>
          )}
          <TrendChart series={history.series} rows={history.rows} />
          <ChartTable series={history.series} rows={history.rows} />
        </section>
      )}
    </>
  );
}
