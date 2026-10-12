import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/EmptyState";
import PackBuild from "@/components/PackBuild";
import { currentSession } from "@/lib/session";
import { loadPack } from "@/lib/team-data";
import type { PackDecision } from "@/lib/pack";
import { formatDateTime } from "@/lib/view";

export const metadata: Metadata = { title: "Monday Pack" };
export const dynamic = "force-dynamic";

const FRESH: Record<string, { text: string; cls: string }> = {
  current: { text: "Up to date with the saved report and current decisions.", cls: "ok" },
  stale_decisions: { text: "Out of date: decisions have changed since this pack was built.", cls: "warn" },
  stale_report: { text: "Out of date: a newer report has been saved since this pack was built.", cls: "warn" },
};

function Rows({ rows }: { rows: PackDecision[] }) {
  return (
    <ul className="pack-list">
      {rows.map((r) => (
        <li key={r.itemId}>
          <strong>{r.theme}</strong>{r.followup && <span className="pill info" style={{ marginLeft: 6 }}>Follow-up</span>}
          <span className="muted small" style={{ display: "block" }}>Decided {r.decidedBy.startsWith("visitor-") ? "anonymously" : "by " + r.decidedBy} · {formatDateTime(r.decidedAt)}{r.votes ? ` · votes at the time: ${r.votes.prioritise} prioritise, ${r.votes.park} park` : ""}</span>
          <span style={{ display: "block" }}>“{r.rationale}”</span>
        </li>
      ))}
    </ul>
  );
}

export default async function Pack() {
  let view;
  try { view = await loadPack(); } catch { view = null; }
  if (!view) return <EmptyState title="We couldn't load the pack" body="The database didn't answer. Nothing was changed. Reload in a moment." action={{ href: "/pack", label: "Reload" }} />;
  const { pack, row, freshness } = view;
  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Planning · built from the saved report and recorded decisions</p>
        <h1>Monday Pack</h1>
        <p className="lede">What the team decided to work on, from the latest Friday report. It is built on request, not on a schedule, and anyone can build or refresh it.</p>
        <div className="chips-row"><PackBuild hasPack={Boolean(row)} /></div>
      </header>
      {!pack || !row ? <EmptyState title="No pack has been built yet" body="When someone builds it, it will list prioritised work from recorded decisions. Until then, nothing is committed for the coming week." action={{ href: "/review", label: "Go to review" }} /> : (
        <>
          <p className={`alert ${freshness === "current" ? "info" : "warn"}`} role="status">{FRESH[freshness]?.text} Built {formatDateTime(row.created_at)}{pack.periodLabel ? ` from the report for ${pack.periodLabel}` : ""}.</p>
          <section className="card card-pad section" aria-labelledby="c-h">
            <h2 id="c-h">Committed (decided by a person)</h2>
            <p className="muted">{pack.message}</p>
            {pack.committed.length > 0 && <Rows rows={pack.committed} />}
          </section>
          {pack.notPursued.length > 0 && <section className="card card-pad section" aria-labelledby="n-h"><h2 id="n-h">Decided not to pursue now</h2><Rows rows={pack.notPursued} /></section>}
          {pack.reportContext && (
            <section className="card card-pad section" aria-labelledby="r-h">
              <h2 id="r-h">From the report (observed)</h2>
              {pack.reportContext.top.length ? <ol className="pack-list">{pack.reportContext.top.map((t) => <li key={t.theme}><strong>{t.theme}</strong><span className="muted small" style={{ display: "block" }}>{t.observed}</span></li>)}</ol> : <p className="muted">No pain point had enough evidence to be ranked.</p>}
              {pack.reportContext.limitations.length > 0 && <details><summary className="small">Limitations ({pack.reportContext.limitations.length})</summary><ul className="pack-list">{pack.reportContext.limitations.map((l) => <li key={l}>{l}</li>)}</ul></details>}
            </section>
          )}
          {pack.suggestions.items.length > 0 && (
            <section className="card card-pad section" aria-labelledby="s-h">
              <h2 id="s-h">{pack.suggestions.label}</h2>
              <p className="muted small">Generated automatically from the report's numbers: not findings, and nobody has approved them.</p>
              <ul className="pack-list">{pack.suggestions.items.map((s) => <li key={s}>{s}</li>)}</ul>
            </section>
          )}
          <p className="muted small">{pack.disclaimer} <Link href="/review">Review &amp; Decisions →</Link></p>
        </>
      )}
    </>
  );
}
