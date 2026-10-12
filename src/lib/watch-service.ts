import type { Session } from "./auth";
import type { TeamStore } from "./team-store";
import { SENSITIVITIES, checkTermChange, normalizeTerm, type Sensitivity, type TermKind, type TermProblem, type WatchTerm } from "./watchlist";
import type { Result } from "./team";

/* Watchlist edits. Owner only. Every accepted change is validated, written, and recorded in the audit log with who and what changed. */
const fail = (status: number, error: string, problems?: TermProblem[]) => ({ ok: false as const, status, error, problems });
type R<T> = Result<T & { warnings: string[] }> | { ok: false; status: number; error: string; problems?: TermProblem[] };

export async function addTerm(
  store: TeamStore, s: Session, topicIds: string[],
  body: { topicId?: unknown; term?: unknown; kind?: unknown; appliesTo?: unknown },
): Promise<R<{ term: WatchTerm }>> {
  if (s.role !== "owner") return fail(403, "Only the owner can change the watchlist.");
  const topic_id = typeof body.topicId === "string" ? body.topicId : "";
  if (!topicIds.includes(topic_id)) return fail(404, "Unknown topic.");
  if (body.kind !== "include" && body.kind !== "exclude") return fail(400, "Kind must be include or exclude.");
  const kind: TermKind = body.kind;
  const n = normalizeTerm(body.term);
  if (!n.ok) return fail(400, n.error);
  const applies_to = typeof body.appliesTo === "string" && body.appliesTo ? body.appliesTo : null;
  if (applies_to && kind !== "exclude") return fail(400, "Only an exclusion can be scoped to a term.");
  const problems = checkTermChange(await store.getTerms(), { topic_id, term: n.term, kind, applies_to });
  const errors = problems.filter((p) => p.level === "error");
  if (errors.length) return fail(409, errors[0].message, problems);
  let term: WatchTerm;
  try { term = await store.addTerm({ topic_id, term: n.term, kind, applies_to }); } catch (e) { return fail(409, (e as Error).message); }
  await store.logChange({ actor: s.email, action: "add", subject: `${kind}:${n.term}`, after: term });
  return { ok: true, term, warnings: problems.map((p) => p.message) };
}

export async function editTerm(store: TeamStore, s: Session, id: string, body: { term?: unknown; status?: unknown }): Promise<R<{ term: WatchTerm }>> {
  if (s.role !== "owner") return fail(403, "Only the owner can change the watchlist.");
  const all = await store.getTerms();
  const cur = all.find((t) => t.id === id);
  if (!cur) return fail(404, "Term not found.");
  const patch: { term?: string; status?: "active" | "paused" } = {};
  let problems: TermProblem[] = [];
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "paused") return fail(400, "Status must be active or paused.");
    patch.status = body.status;
  }
  if (body.term !== undefined) {
    const n = normalizeTerm(body.term);
    if (!n.ok) return fail(400, n.error);
    problems = checkTermChange(all, { topic_id: cur.topic_id, term: n.term, kind: cur.kind, applies_to: cur.applies_to }, cur.id);
    const errors = problems.filter((p) => p.level === "error");
    if (errors.length) return fail(409, errors[0].message, problems);
    patch.term = n.term;
  }
  if (!Object.keys(patch).length) return fail(400, "Nothing to change.");
  // Pausing the last active include term would silently stop monitoring the topic: refuse it, say why.
  if (patch.status === "paused" && cur.kind === "include" && !all.some((t) => t.topic_id === cur.topic_id && t.kind === "include" && t.status === "active" && t.id !== cur.id)) {
    return fail(409, "That is the topic's last active term. Pausing it would stop monitoring the topic; add another term first or leave this one active.");
  }
  let term: WatchTerm | null;
  try { term = await store.updateTerm(id, patch); } catch (e) { return fail(409, (e as Error).message); }
  if (!term) return fail(404, "Term not found.");
  const action = patch.status ? (patch.status === "paused" ? "pause" : "resume") : "edit";
  await store.logChange({ actor: s.email, action, subject: `${cur.kind}:${cur.term}`, before: cur, after: term });
  return { ok: true, term, warnings: problems.map((p) => p.message) };
}

export async function removeTerm(store: TeamStore, s: Session, id: string): Promise<R<{ removed: true }>> {
  if (s.role !== "owner") return fail(403, "Only the owner can change the watchlist.");
  const all = await store.getTerms();
  const cur = all.find((t) => t.id === id);
  if (!cur) return fail(404, "Term not found.");
  if (cur.kind === "include" && !all.some((t) => t.topic_id === cur.topic_id && t.kind === "include" && t.status === "active" && t.id !== cur.id)) {
    return fail(409, "That is the topic's last active term. Removing it would stop monitoring the topic; add another term first.");
  }
  await store.removeTerm(id);
  await store.logChange({ actor: s.email, action: "remove", subject: `${cur.kind}:${cur.term}`, before: cur });
  return { ok: true, removed: true, warnings: [] };
}

export async function setSensitivity(store: TeamStore, s: Session, value: unknown): Promise<R<{ sensitivity: Sensitivity }>> {
  if (s.role !== "owner") return fail(403, "Only the owner can change the watchlist.");
  if (!SENSITIVITIES.includes(value as Sensitivity)) return fail(400, "Sensitivity must be strict, balanced or early.");
  const before = await store.getSensitivity();
  if (before !== value) {
    await store.setSensitivity(value as Sensitivity, s.email);
    await store.logChange({ actor: s.email, action: "sensitivity", subject: "sensitivity", before, after: value });
  }
  return { ok: true, sensitivity: value as Sensitivity, warnings: [] };
}
