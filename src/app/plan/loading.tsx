export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite" className="stack">
      <span className="sr-only">Loading…</span>
      <div className="skeleton" style={{ height: 40, width: "45%" }} />
      <div className="skeleton" style={{ height: 160 }} />
      <div className="skeleton" style={{ height: 160 }} />
    </div>
  );
}
