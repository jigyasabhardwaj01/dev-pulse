import type { Comparison, Coverage } from "./coverage";
import type { ThemeTrend } from "./types";

/** The content of one saved report version. Everything the dashboard and the email show comes from this. */
export interface BriefDraft {
  narrative: string;
  points: ThemeTrend[];
  coverage: { sources: Coverage; comparison: Comparison };
  /** Posts in the reporting period that were still unclassified when this version was built. */
  pendingCount: number;
  usedFallback: boolean;
}

export type EmailState = "sending" | "sent" | "failed" | null;

export interface BriefRecord extends BriefDraft {
  week_start: string;
  version: number; // starts at 1; bumped only when the saved content actually changes
  emailStatus: EmailState;
  emailedVersion: number | null; // the version that was accepted by the email provider
  createdAt: string;
}

export type BriefAction = "create" | "replace" | "unchanged" | "keep";

/** Once an email is being sent or has been sent, the saved report is the delivered version and never changes. */
export const isFrozen = (b: Pick<BriefRecord, "emailStatus"> | null): boolean =>
  b !== null && (b.emailStatus === "sent" || b.emailStatus === "sending");

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Persistence policy for a period's saved report:
 *  - no report yet                               -> create
 *  - delivered, or being delivered               -> keep (never silently change what was sent)
 *  - the rerun is less complete (more unclassified posts) -> keep (a partial rerun must not replace a better report)
 *  - the rerun would swap an AI narrative for the fallback -> keep
 *  - identical content                           -> unchanged (no version churn)
 *  - otherwise                                   -> replace (bumps the version)
 */
export function decideBriefWrite(existing: BriefRecord | null, draft: BriefDraft): { action: BriefAction; reason: string } {
  if (!existing) return { action: "create", reason: "no saved report for this period" };
  if (isFrozen(existing)) return { action: "keep", reason: `report is ${existing.emailStatus === "sent" ? "already delivered" : "being delivered"}` };
  if (draft.pendingCount > existing.pendingCount) return { action: "keep", reason: "rerun is less complete than the saved report" };
  if (draft.usedFallback && !existing.usedFallback) return { action: "keep", reason: "rerun would replace the AI narrative with the fallback" };
  if (same(existing.narrative, draft.narrative) && same(existing.points, draft.points) && same(existing.coverage, draft.coverage)) {
    return { action: "unchanged", reason: "identical to the saved report" };
  }
  return { action: "replace", reason: "rerun is at least as complete" };
}
