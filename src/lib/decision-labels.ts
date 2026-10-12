/** One set of plain words for where a problem stands, used on every page. */
export const OUTCOME_LABEL: Record<string, string> = { prioritised: "Work on this", parked: "Not now", rejected: "Not a problem for us", already_addressed: "Already handled" };
export const STATE_LABEL: Record<string, string> = {
  under_review: "Shortlisted", open_for_votes: "Shortlisted · open for votes", prioritised: OUTCOME_LABEL.prioritised, parked: OUTCOME_LABEL.parked,
  rejected: OUTCOME_LABEL.rejected, already_addressed: OUTCOME_LABEL.already_addressed, withdrawn: "Not shortlisted",
};
export const STATE_TONE: Record<string, string> = { under_review: "info", open_for_votes: "info", prioritised: "ok", parked: "neutral", rejected: "neutral", already_addressed: "neutral", withdrawn: "neutral" };
