import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/EmptyState";
import ReliabilityPill from "@/components/ReliabilityPill";
import { listReports } from "@/lib/data";
import { overviewHref, reportHref } from "@/lib/insights";
import { truncate } from "@/lib/text";

export const metadata: Metadata = { title: "Weekly Reports" };
export const dynamic = "force-dynamic";

const DELIVERY: Record<string, string> = { sent: "Emailed", sending: "Sending", failed: "Email failed", not_sent: "Not emailed", unknown: "" };

export default async function Reports() {
  let reports = null;
  try { reports = await listReports(); } catch { /* handled below */ }
  if (!reports) return <EmptyState title="We couldn't load the reports" body="The database didn't answer. Nothing was changed. Try again in a moment." action={{ href: "/reports", label: "Try again" }} />;
  if (!reports.length) return <EmptyState title="No reports yet" body="Reports appear here after the first weekly run." action={{ href: "/status", label: "Check pipeline health" }} />;
  const ist = reports.filter((r) => r.kind === "ist");
  const legacy = reports.filter((r) => r.kind === "legacy");
  const card = (r: (typeof reports)[number]) => (
    <li key={r.weekStart} className="card report-card">
      <div className="rc-title">
        <strong>{r.periodLabel}</strong>
        <span className="muted small">{truncate(r.narrative, 140)}</span>
        <span className="chips-row" style={{ gap: 6 }}>
          <ReliabilityPill value={r.reliability} />
          {DELIVERY[r.delivery] && <span className="pill neutral">{DELIVERY[r.delivery]}</span>}
          {r.version ? <span className="faint small">v{r.version}</span> : null}
        </span>
      </div>
      <div className="rc-stats">
        <div className="rc-stat"><b>{r.mentions}</b><span>Mentions</span></div>
        <div className="rc-stat"><b>{r.painPoints}</b><span>Pain points</span></div>
        <div className="rc-stat"><b>{r.sourcesTotal ? `${r.sourcesOk}/${r.sourcesTotal}` : "–"}</b><span>Sources ok</span></div>
      </div>
      <div className="rc-open" style={{ display: "grid", gap: 4 }}>
        <Link className="btn primary" href={reportHref(r.weekStart)}>Open report<span className="sr-only"> for {r.periodLabel}</span></Link>
        <Link className="small" href={overviewHref(r.weekStart)}>On overview</Link>
      </div>
    </li>
  );
  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Archive</p>
        <h1>Weekly Reports</h1>
        <p className="lede">One saved report per reporting week, each covering seven complete IST days. A delivered report never changes.</p>
      </header>
      <section className="section" aria-labelledby="ist-h">
        <div className="section-head"><h2 id="ist-h">Weekly period reports</h2><p>{ist.length} {ist.length === 1 ? "report" : "reports"}, newest first</p></div>
        {ist.length ? <ul className="report-cards">{ist.map(card)}</ul> : <div className="card empty"><p className="muted">No reports on the weekly period format yet.</p></div>}
      </section>
      {legacy.length > 0 && (
        <section className="section" aria-labelledby="leg-h">
          <div className="section-head"><h2 id="leg-h">Earlier-format reports</h2><p>Recorded before source coverage was tracked; shown for reference, never compared with the weeks above.</p></div>
          <ul className="report-cards">{legacy.map(card)}</ul>
        </section>
      )}
    </>
  );
}
