import type { Decision, ReviewItem } from "./team-store";
import type { FridayBrief } from "./friday-brief";
import { decisionsDigest } from "./team";

/*
 * The Monday sprint pack. Built ONLY from the saved Friday report and the current, final decisions. It is a document
 * for planning, not a schedule: nothing here invents a calendar, an owner or an estimate. Automatically generated suggestions are kept in
 * their own labelled section; the committed list contains only what a human decided.
 */
export interface PackDecision {
  itemId: string; theme: string; topicId: string; outcome: Decision["outcome"]; decidedBy: string; decidedAt: string; rationale: string;
  followup: boolean; votes: { prioritise: number; park: number; total: number } | null; firstWeek: string | null;
}
export interface SprintPack {
  version: 1;
  builtAt: string;
  weekStart: string | null;
  periodLabel: string | null;
  state: "ready" | "no_decisions" | "no_report";
  message: string;
  /** Decided by a human: the work the owner chose to prioritise. */
  committed: PackDecision[];
  /** Decided by a human: deliberately not pursued now. */
  notPursued: PackDecision[];
  followups: PackDecision[];
  /** Context from the saved report (observed), so the pack stands alone. */
  reportContext: { top: { rank?: number; theme: string; observed: string }[]; limitations: string[] } | null;
  /** AI-generated, NOT approved by anyone. */
  suggestions: { label: string; items: string[] };
  disclaimer: string;
}

export const PACK_DISCLAIMER = "Committed items are recorded decisions. Suggestions are prompts generated automatically from the report's numbers; they are not findings and not approved work. Votes informed the discussion; they did not decide it.";

export function buildPack(args: { now: Date; brief: FridayBrief | null; items: ReviewItem[]; decisions: Decision[]; votesByItem?: Map<string, { prioritise: number; park: number; total: number }> }): { pack: SprintPack; digest: string } {
  const byItem = new Map(args.items.map((i) => [i.id, i]));
  const current = args.decisions.filter((d) => !d.superseded_at && byItem.has(d.item_id));
  const toRow = (d: Decision): PackDecision => {
    const it = byItem.get(d.item_id)!;
    return { itemId: it.id, theme: it.theme, topicId: it.topic_id, outcome: d.outcome, decidedBy: d.decided_by, decidedAt: d.decided_at, rationale: d.rationale, followup: d.followup, votes: d.vote_snapshot ?? null, firstWeek: it.first_week };
  };
  const rows = current.map(toRow).sort((a, b) => a.decidedAt.localeCompare(b.decidedAt) || a.itemId.localeCompare(b.itemId));
  const committed = rows.filter((r) => r.outcome === "prioritised");
  const notPursued = rows.filter((r) => r.outcome !== "prioritised");
  const state: SprintPack["state"] = !args.brief ? "no_report" : rows.length === 0 ? "no_decisions" : "ready";
  const message = state === "no_report" ? "There is no saved Friday report yet, so there is nothing to plan from."
    : state === "no_decisions" ? "No decisions have been recorded yet. Nothing is committed for the coming week; the suggestions below are prompts only."
      : committed.length === 0 ? "Decisions are recorded, but none was prioritised: nothing is committed for the coming week."
        : `${committed.length} item${committed.length === 1 ? "" : "s"} prioritised.`;
  const pack: SprintPack = {
    version: 1, builtAt: args.now.toISOString(), weekStart: args.brief?.weekStart ?? null, periodLabel: args.brief?.periodLabel ?? null, state, message,
    committed, notPursued, followups: rows.filter((r) => r.followup),
    reportContext: args.brief ? { top: args.brief.observed.top.map((t) => ({ rank: t.rank, theme: t.theme, observed: t.observed })), limitations: args.brief.observed.limitations } : null,
    suggestions: args.brief ? { label: args.brief.suggestions.label, items: args.brief.suggestions.items.map((s) => s.text) } : { label: "Suggestions", items: [] },
    disclaimer: PACK_DISCLAIMER,
  };
  return { pack, digest: decisionsDigest(args.decisions) };
}

/** A saved pack is stale when decisions changed since it was built, or a newer report exists. */
export function packFreshness(saved: { digest: string; weekStart: string | null } | null, currentDigest: string, latestWeek: string | null): "none" | "current" | "stale_decisions" | "stale_report" {
  if (!saved) return "none";
  if (saved.digest !== currentDigest) return "stale_decisions";
  if (latestWeek && saved.weekStart && latestWeek > saved.weekStart) return "stale_report";
  return "current";
}
