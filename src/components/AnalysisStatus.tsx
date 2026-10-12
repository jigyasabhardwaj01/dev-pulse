import { analysisFor } from "@/lib/analysis-source";
import { makeSupabaseStore } from "@/lib/store";
import { makeSupabaseTeamStore } from "@/lib/team-store";
import { formatDateTime } from "@/lib/view";
import { DeriveButton } from "./ReviewControls";

/** Says which analysis stands behind this report's pain points, so shortlisting and the Monday pack are never silently unavailable. */
export default async function AnalysisStatus({ week }: { week: string }) {
  let a;
  try { a = await analysisFor(makeSupabaseStore(), makeSupabaseTeamStore(), week); } catch { return null; }
  if (a.kind === "sealed") return <p className="alert info" role="note"><span><strong>Sealed analysis.</strong> Pain points on this report can be shortlisted for team review and feed the Monday pack.</span></p>;
  if (a.kind === "derived") {
    return (
      <p className="alert info" role="note"><span><strong>Derived analysis.</strong> This report was saved before sealed analyses existed. One was derived on {formatDateTime(a.provenance.derivedAt)} from stored evidence ({a.provenance.evidencePosts} posts); it is not part of the delivered report. {a.provenance.legacyClassification ? "These posts have no excerpts or confidence scores, so nothing is ranked." : ""}</span></p>
    );
  }
  return (
    <div className="alert warn" role="note">
      <span><strong>No analysis for this report.</strong> It was saved before sealed analyses existed, so its pain points cannot be shortlisted yet. The next scheduled report will include one.{" You can derive one from the evidence already stored; this does not change the report, collect new data or send email."}</span>
      <DeriveButton weekStart={week} />
    </div>
  );
}
