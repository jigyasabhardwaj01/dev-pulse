import Link from "next/link";
import { formatDateTime } from "@/lib/view";
import type { ReportView } from "@/lib/report-model";

function Delivery({ d }: { d: ReportView["delivery"] }) {
  switch (d.status) {
    case "sent": return <span className="pill ok">✓ Emailed{d.sentAt ? ` ${formatDateTime(d.sentAt)}` : ""}</span>;
    case "sending": return <span className="pill info">Email sending…</span>;
    case "failed": return <span className="pill bad">Email failed; will retry on the next run</span>;
    case "not_sent": return <span className="pill neutral">Not emailed yet</span>;
    default: return null;
  }
}

export default function ReportHeader({ report }: { report: ReportView }) {
  const { prev, next } = report.nav;
  return (
    <header className="page-head">
      <p className="eyebrow">{report.kind === "ist" ? "Weekly JARVIS report" : "Earlier-format report"}</p>
      <h1>{report.periodLabel}</h1>
      <div className="meta-row">
        <Delivery d={report.delivery} />
        {report.version !== null && <span>Report version {report.version}</span>}
        <span>Generated {formatDateTime(report.generatedAt)}</span>
      </div>
      {(prev || next) && (
        <nav className="pager" aria-label="Other weekly reports">
          <Link className="btn" href={prev ? `/?week=${prev}` : "#"} aria-disabled={!prev} tabIndex={prev ? undefined : -1}><span aria-hidden="true">←</span> Previous week</Link>
          <Link className="btn" href={next ? `/?week=${next}` : "/"} aria-disabled={!next} tabIndex={next ? undefined : -1}>Next week <span aria-hidden="true">→</span></Link>
          <Link className="btn" href="/history">All reports</Link>
        </nav>
      )}
    </header>
  );
}
