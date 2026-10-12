/** Shown while a report loads. Kept out of loading.tsx so the page can still return a real 404 for an unknown week. */
export default function ReportSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" style={{ display: "grid", gap: 16 }}>
      <span className="sr-only">Loading the report…</span>
      <div className="skeleton" style={{ height: 38, width: "50%" }} />
      <div className="skeleton" style={{ height: 22, width: "70%" }} />
      <div className="grid-2"><div className="skeleton" style={{ height: 150 }} /><div className="kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 70 }} />)}</div></div>
      <div className="skeleton" style={{ height: 150 }} />
      <div className="skeleton" style={{ height: 260 }} />
    </div>
  );
}
