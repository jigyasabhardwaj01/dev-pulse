import { comparisonCaveats, type Comparison } from "@/lib/coverage";
import type { TrendReliability } from "@/lib/report-model";

/** Says plainly why trends are, or are not, being shown. Renders nothing when there is nothing to qualify. */
export default function DataQuality({ reliability, comparison, usedFallback }: { reliability: TrendReliability; comparison: Comparison | null; usedFallback: boolean }) {
  const caveats = comparisonCaveats(comparison);
  const blocks: React.ReactNode[] = [];

  if (reliability === "legacy") {
    blocks.push(
      <div key="legacy" className="banner info" role="note">
        <span><span className="tag">Earlier-format report.</span> It was produced before source coverage was recorded, so we can&apos;t say which sources were healthy. Mention counts are shown and trend arrows are not. Treat any rise or fall described in the summary above as unverified.</span>
      </div>,
    );
  } else if (reliability === "no_prior") {
    blocks.push(
      <div key="np" className="banner info" role="note">
        <span><span className="tag">First report on this period format.</span> There is no earlier report on the same weekly period to compare with, so trend arrows start next week.</span>
      </div>,
    );
  } else if (reliability === "incomparable") {
    blocks.push(
      <div key="inc" className="banner warn" role="note">
        <span><span className="tag">Trends not compared.</span> Source coverage differs from the previous period, so a rise or fall would not be reliable. Counts are still accurate for this period.</span>
        {comparison && comparison.reasons.length > 0 && <ul>{comparison.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      </div>,
    );
  }
  if (caveats.length) {
    blocks.push(
      <div key="cav" className="banner info" role="note">
        <span><span className="tag">Read with care.</span></span>
        <ul>{caveats.map((c) => <li key={c}>{c}</li>)}</ul>
      </div>,
    );
  }
  if (usedFallback) {
    blocks.push(
      <div key="fb" className="banner info" role="note">
        <span>The summary above was written from a template because the AI summary was unavailable. The numbers are unaffected.</span>
      </div>,
    );
  }
  return blocks.length ? <div style={{ display: "grid", gap: 10 }}>{blocks}</div> : null;
}
