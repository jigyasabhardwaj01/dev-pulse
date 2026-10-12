/** Shown while a report loads. Kept out of loading.tsx so the page can still return a real 404 for a bad week. */
export default function ReportSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" style={{ display: "grid", gap: 16 }}>
      <span className="sr-only">Loading the report…</span>
      <div className="skeleton" style={{ height: 34, width: "55%" }} />
      <div className="skeleton" style={{ height: 96 }} />
      <div className="tiles">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 92 }} />)}</div>
      <div className="skeleton" style={{ height: 220 }} />
    </div>
  );
}
