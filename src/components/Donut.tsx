/** Two-part ring with real values only: `part` of `total`. No animation, and a text alternative. */
export default function Donut({ part, total, label, partLabel, restLabel }: { part: number; total: number; label: string; partLabel: string; restLabel: string }) {
  const r = 42, c = 2 * Math.PI * r;
  const share = total > 0 ? part / total : 0;
  const dash = share * c;
  return (
    <div className="donut-wrap">
      <svg width="132" height="132" viewBox="0 0 100 100" role="img" aria-label={`${label}: ${part} of ${total} (${Math.round(share * 100)}%)`}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="11" />
        {total > 0 && part > 0 && <circle cx="50" cy="50" r={r} fill="none" stroke="var(--accent-2)" strokeWidth="11" strokeLinecap="round" strokeDasharray={`${Math.max(dash - 2, 0.1)} ${c}`} transform="rotate(-90 50 50)" />}
        <text x="50" y="47" textAnchor="middle" fontSize="8" fill="var(--muted)">{label}</text>
        <text x="50" y="62" textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--text)">{total > 0 ? `${Math.round(share * 100)}%` : "–"}</text>
      </svg>
      <div className="donut-legend">
        <div><i style={{ background: "var(--accent-2)" }} /><span><strong className="num">{part}</strong> {partLabel}</span></div>
        <div><i style={{ background: "var(--surface-3)", border: "1px solid var(--border-strong)" }} /><span><strong className="num">{Math.max(total - part, 0)}</strong> {restLabel}</span></div>
      </div>
    </div>
  );
}
