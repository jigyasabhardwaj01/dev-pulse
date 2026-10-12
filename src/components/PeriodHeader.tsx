import Link from "next/link";
import { comparisonStatus, overviewHref, reportHref } from "@/lib/insights";
import type { ReportView } from "@/lib/report-model";
import { formatDateTime } from "@/lib/view";

const DELIVERY: Record<string, { cls: string; text: (r: ReportView) => string } | undefined> = {
  sent: { cls: "ok", text: (r) => `Emailed${r.delivery.sentAt ? ` ${formatDateTime(r.delivery.sentAt)}` : ""}` },
  sending: { cls: "info", text: () => "Email sending…" },
  failed: { cls: "bad", text: () => "Email failed; will retry on the next run" },
  not_sent: { cls: "neutral", text: () => "Not emailed yet" },
};

/** Heading, selected reporting period, comparison status and week navigation. Used by the overview and by each report page. */
export default function PeriodHeader({ report, mode }: { report: ReportView; mode: "overview" | "report" }) {
  const cmp = comparisonStatus(report.reliability, report.weekStart);
  const d = DELIVERY[report.delivery.status];
  const { prev, next } = report.nav;
  const to = (w: string) => (mode === "overview" ? overviewHref(w) : reportHref(w));
  return (
    <header className="page-head">
      <p className="eyebrow">{mode === "overview" ? "JARVIS · weekly" : "Weekly report"}</p>
      <h1>{mode === "overview" ? "Developer Intelligence" : report.periodLabel}</h1>
      {mode === "overview" && (
        <p className="lede">What developers are struggling with across Hacker News, Stack Overflow, Reddit and GitHub Issues, how it moved since last week, and what is still unresolved.</p>
      )}
      <div className="chips-row">
        {mode === "overview" && <span className="pill accent">{report.periodLabel}</span>}
        <span className={`pill ${cmp.tone === "ok" ? "ok" : cmp.tone === "warn" ? "warn" : cmp.tone === "info" ? "info" : "neutral"}`} title={cmp.detail}>{cmp.label}</span>
        {d && <span className={`pill ${d.cls}`}>{d.text(report)}</span>}
        {report.version !== null && <span className="muted small">Version {report.version}</span>}
        <span className="muted small">Generated {formatDateTime(report.generatedAt)}</span>
      </div>
      <p className="muted small">{cmp.detail}</p>
      {(prev || next || mode === "overview") && (
        <nav className="pager" aria-label="Choose a reporting week">
          <Link className="btn" href={prev ? to(prev) : "#"} aria-disabled={!prev} tabIndex={prev ? undefined : -1}><span aria-hidden="true">←</span> Previous week</Link>
          <Link className="btn" href={next ? to(next) : mode === "overview" ? "/" : "#"} aria-disabled={!next} tabIndex={next ? undefined : -1}>Next week <span aria-hidden="true">→</span></Link>
          {mode === "overview" ? <Link className="btn" href={reportHref(report.weekStart)}>Open full report</Link> : <Link className="btn" href={overviewHref(report.weekStart)}>Open on overview</Link>}
          <Link className="btn" href="/reports">All reports</Link>
        </nav>
      )}
    </header>
  );
}
