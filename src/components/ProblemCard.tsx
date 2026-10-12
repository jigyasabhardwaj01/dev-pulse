import Link from "next/link";
import { problemHref, type ProblemView } from "@/lib/insights-view";
import { sourceName } from "@/lib/insights-view";

const TREND_TONE = { increasing: "warn", decreasing: "ok", steady: "neutral", new: "info", unknown: "neutral" } as const;
const CONF_TONE = { high: "ok", medium: "info", low: "neutral" } as const;

export function EvidenceList({ links, max = 2 }: { links: ProblemView["evidence"]; max?: number }) {
  const shown = links.filter((l) => l.url).slice(0, max);
  if (!shown.length) return <p className="muted small">No source link was kept for this problem.</p>;
  return (
    <ul className="evidence">
      {shown.map((l) => (
        <li key={l.id}>
          {l.excerpt ? <q>{l.excerpt}</q> : <span>{l.title}</span>}
          <span className="src">{sourceName(l.source)} · <a href={l.url!} target="_blank" rel="noopener noreferrer">Read the original discussion<span className="sr-only"> (opens in a new tab)</span></a></span>
        </li>
      ))}
    </ul>
  );
}

/** One problem in plain English: what it is, why it matters, who runs into it, how sure we are, and where the proof is. */
export default function ProblemCard({ p, headingLevel = 2 }: { p: ProblemView; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <li className="card problem" aria-label={p.theme}>
      <div className="problem-head">
        <span className={`rank${p.rank ? "" : " plain"}`} aria-label={p.rank ? `Number ${p.rank}` : "Not ranked"}>{p.rank ?? "–"}</span>
        <div className="stack" style={{ gap: 4 }}>
          <H>{p.theme}</H>
          <p className="cat">{p.category}{!p.supported && " · early signal, not ranked"}</p>
        </div>
      </div>
      <p>{p.whyItMatters}</p>
      <dl className="facts">
        <div><dt>Who runs into it</dt><dd>{p.who}</dd></div>
        <div><dt>Supporting discussions</dt><dd>{p.discussions}<small>{p.sources.join(", ")}{p.repeats > 0 ? ` · ${p.repeats} replies or repeats not counted twice` : ""}</small></dd></div>
        <div><dt>Compared with last week</dt><dd><span className={`pill ${TREND_TONE[p.trend.kind]}`}>{p.trend.label}</span><small>{p.trend.detail}</small></dd></div>
        <div><dt>How sure are we</dt><dd><span className={`pill ${CONF_TONE[p.confidence.level]}`}>{p.confidence.label}</span><small>{p.confidence.detail}</small></dd></div>
      </dl>
      {p.notRankedBecause && <p className="muted small">{p.notRankedBecause}</p>}
      <div className="stack" style={{ gap: 6 }}>
        <p className="small muted" style={{ fontWeight: 650 }}>Evidence</p>
        <EvidenceList links={p.evidence} />
      </div>
      <div className="actions"><Link className="btn primary" href={problemHref(p)}>Explore &amp; decide<span className="sr-only">: {p.theme}</span></Link></div>
    </li>
  );
}
