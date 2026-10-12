import { createHash } from "node:crypto";
import type { Choice, Decision, Outcome, ReviewItem, ReviewState, TeamStore, Vote, VoteTally } from "./team-store";
import { CHOICES, OUTCOMES } from "./team-store";
import type { Session } from "./auth";
import type { EvidenceLink } from "./analysis";

/*
 * The review workflow. Every function takes the SERVER-resolved session (from the signed cookie and the roster) and checks the
 * role itself: nothing the browser sends can grant a role or choose who is acting. Votes are advice; an owner decision is a
 * separate record that is never computed from the tally, and the tally at the time is stored beside it so both stay auditable.
 */
export type Result<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };
const fail = (status: number, error: string) => ({ ok: false as const, status, error });

/** Where in the saved reports a theme can be checked, so only a real pain point can be shortlisted. */
export type PainPointLookup = (weekStart: string, topicId: string, theme: string) => Promise<{ links: EvidenceLink[]; discussions: number } | null>;

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
export const tally = (votes: Pick<Vote, "choice">[]): VoteTally => {
  const prioritise = votes.filter((v) => v.choice === "prioritise").length;
  return { prioritise, park: votes.length - prioritise, total: votes.length };
};

export async function shortlist(
  store: TeamStore, s: Session, lookup: PainPointLookup,
  body: { weekStart?: unknown; topicId?: unknown; theme?: unknown; reason?: unknown },
): Promise<Result<{ item: ReviewItem; created: boolean }>> {
  const weekStart = text(body.weekStart, 10), topicId = text(body.topicId, 64), theme = text(body.theme, 120), reason = text(body.reason, 500);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !topicId || !theme) return fail(400, "A week, topic and theme are required.");
  if (reason.length < 3) return fail(400, "Say briefly why this deserves review (at least 3 characters).");
  const found = await lookup(weekStart, topicId, theme);
  if (!found) return fail(404, "That pain point is not in the saved report for this week.");
  const { item, created } = await store.createItem({ topic_id: topicId, theme, reason, first_week: weekStart, created_by: s.email });
  await store.addEvent({ item_id: item.id, actor: s.email, action: created ? "shortlisted" : "shortlist_repeated", detail: { weekStart, reason, discussions: found.discussions } });
  return { ok: true, item, created };
}

/**
 * Unshortlist. The person who shortlisted it, or the owner, may withdraw an item that has no recorded decision. The row and its
 * audit events stay; its votes are cleared (the count is recorded in the event). Shortlisting the same theme again reopens it.
 */
export async function withdrawItem(store: TeamStore, s: Session, id: string): Promise<Result<{ item: ReviewItem }>> {
  const cur = await store.getItem(id);
  if (!cur) return fail(404, "Item not found.");
  if (s.role !== "owner" && cur.created_by !== s.email) return fail(403, "Only the person who shortlisted this, or the owner, can withdraw it.");
  if (cur.state === "withdrawn") return { ok: true, item: cur };
  if (!["under_review", "open_for_votes"].includes(cur.state) || (await store.listDecisions(id)).length) return fail(409, "A decision has been recorded for this item, so it can no longer be withdrawn. The owner can record a new decision instead.");
  const from = cur.state;
  const discarded = await store.clearVotes(id);
  const item = await store.setState(id, "withdrawn");
  if (!item) return fail(404, "Item not found.");
  await store.addEvent({ item_id: id, actor: s.email, action: "withdrawn", detail: { from, votesDiscarded: discarded } });
  return { ok: true, item };
}

/** The owner opens an item for voting, or returns it to review. Final states are changed only by recording a decision. */
export async function setItemState(store: TeamStore, s: Session, id: string, state: unknown): Promise<Result<{ item: ReviewItem }>> {
  if (s.role !== "owner") return fail(403, "Only the owner can change an item's state.");
  if (state !== "open_for_votes" && state !== "under_review") return fail(400, "State must be open_for_votes or under_review. Final outcomes are recorded as decisions.");
  const cur = await store.getItem(id);
  if (!cur) return fail(404, "Item not found.");
  if (cur.state === state) return { ok: true, item: cur };
  const from = cur.state;
  const item = await store.setState(id, state as ReviewState);
  if (!item) return fail(404, "Item not found.");
  await store.addEvent({ item_id: id, actor: s.email, action: "state_changed", detail: { from, to: state } });
  return { ok: true, item };
}

export async function castVote(store: TeamStore, s: Session, id: string, choice: unknown): Promise<Result<{ tally: VoteTally; mine: Choice }>> {
  if (!CHOICES.includes(choice as Choice)) return fail(400, "Choose prioritise or park.");
  const item = await store.getItem(id);
  if (!item) return fail(404, "Item not found.");
  if (item.state !== "open_for_votes") return fail(409, "Voting is not open on this item.");
  await store.upsertVote(id, s.email, choice as Choice); // the voter is the signed-in person, never a value from the request
  await store.addEvent({ item_id: id, actor: s.email, action: "voted", detail: { choice } });
  return { ok: true, tally: tally(await store.listVotes(id)), mine: choice as Choice };
}

export async function withdrawVote(store: TeamStore, s: Session, id: string): Promise<Result<{ tally: VoteTally }>> {
  const item = await store.getItem(id);
  if (!item) return fail(404, "Item not found.");
  if (item.state !== "open_for_votes") return fail(409, "Voting is not open on this item.");
  if (await store.deleteVote(id, s.email)) await store.addEvent({ item_id: id, actor: s.email, action: "vote_withdrawn" });
  return { ok: true, tally: tally(await store.listVotes(id)) };
}

export async function decide(
  store: TeamStore, s: Session, id: string, body: { outcome?: unknown; rationale?: unknown; followup?: unknown },
): Promise<Result<{ decisionId: number; tally: VoteTally }>> {
  if (s.role !== "owner") return fail(403, "Only the owner can record a decision.");
  if (!OUTCOMES.includes(body.outcome as Outcome)) return fail(400, "Outcome must be prioritised, parked, rejected or already_addressed.");
  const rationale = text(body.rationale, 1000);
  if (!rationale) return fail(400, "A decision needs a written rationale.");
  const item = await store.getItem(id);
  if (!item) return fail(404, "Item not found.");
  const votes = tally(await store.listVotes(id));
  // The tally is recorded for the audit trail. It is deliberately not an input to the outcome.
  const decisionId = await store.recordDecision({
    item_id: id, outcome: body.outcome as Outcome, decided_by: s.email, rationale,
    evidence: { weekStart: item.first_week, theme: item.theme }, vote_snapshot: votes, followup: body.followup === true,
  });
  return { ok: true, decisionId, tally: votes };
}

/** What a signed-in person sees for one item: who voted is shown only to the owner, members see the tally and their own vote. */
export async function viewItem(store: TeamStore, s: Session, item: ReviewItem) {
  const votes = await store.listVotes(item.id);
  const decisions = await store.listDecisions(item.id);
  return {
    item, tally: tally(votes), mine: votes.find((v) => v.voter === s.email)?.choice ?? null,
    voters: s.role === "owner" ? votes.map((v) => ({ voter: v.voter, choice: v.choice })) : undefined,
    current: decisions.find((d) => !d.superseded_at) ?? null,
    history: decisions.filter((d) => d.superseded_at),
  };
}

/** Identifies the exact set of current decisions, so a pack built earlier is visibly stale once any decision changes. */
export function decisionsDigest(decisions: Pick<Decision, "id" | "item_id" | "outcome" | "superseded_at">[]): string {
  const cur = decisions.filter((d) => !d.superseded_at).map((d) => `${d.item_id}:${d.id}:${d.outcome}`).sort();
  return createHash("sha256").update(cur.join("|")).digest("hex").slice(0, 32);
}
