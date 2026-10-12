import type { DerivedAnalysis, Choice, Decision, PackRow, ReviewEvent, ReviewItem, ReviewState, TeamStore, Vote, WatchChange } from "@/lib/team-store";
import type { Sensitivity, WatchTerm } from "@/lib/watchlist";

/** An in-memory TeamStore with the same uniqueness and atomicity guarantees the database gives. */
export function memoryTeamStore(seed: { terms?: WatchTerm[] } = {}) {
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const s = {
    terms: [...(seed.terms ?? [])] as WatchTerm[], sensitivity: "balanced" as Sensitivity, changes: [] as WatchChange[], items: [] as ReviewItem[], votes: [] as Vote[],
    decisions: [] as Decision[], events: [] as ReviewEvent[], packs: [] as PackRow[], derived: [] as DerivedAnalysis[], alerts: [] as { key: string; kind: string; at: Date }[],
    matched: [] as { topic_id: string; matched_terms: string[] | null }[],
  };
  const iso = () => new Date().toISOString();
  const store: TeamStore = {
    async getTerms() { return s.terms.map((t) => ({ ...t })); },
    async addTerm(t) {
      if (s.terms.some((x) => x.topic_id === t.topic_id && x.kind === t.kind && x.term === t.term && (x.applies_to ?? null) === (t.applies_to ?? null))) throw new Error("That term already exists on this topic.");
      const row: WatchTerm = { id: id(), status: "active", ...t }; s.terms.push(row); return { ...row };
    },
    async updateTerm(i, patch) {
      const t = s.terms.find((x) => x.id === i); if (!t) return null;
      if (patch.term && s.terms.some((x) => x.id !== i && x.topic_id === t.topic_id && x.kind === t.kind && x.term === patch.term && x.applies_to === t.applies_to)) throw new Error("That term already exists on this topic.");
      Object.assign(t, patch); return { ...t };
    },
    async removeTerm(i) { const l = s.terms.length; s.terms = s.terms.filter((x) => x.id !== i && x.applies_to !== i); return s.terms.length < l; },
    async getSensitivity() { return s.sensitivity; },
    async setSensitivity(v) { s.sensitivity = v; },
    async logChange(c) { s.changes.push({ id: s.changes.length + 1, at: iso(), actor: c.actor, action: c.action, subject: c.subject, before: c.before ?? null, after: c.after ?? null }); },
    async getChanges(limit) { return [...s.changes].reverse().slice(0, limit); },
    async getMatchedTerms() { return s.matched; },

    async listItems() { return [...s.items]; },
    async getItem(i) { return s.items.find((x) => x.id === i) ?? null; },
    async createItem(i) {
      const ex = s.items.find((x) => x.topic_id === i.topic_id && x.theme === i.theme);
      if (ex) { if (ex.state === "withdrawn") { ex.state = "under_review"; ex.reason = i.reason; return { item: ex, created: true }; } return { item: ex, created: false }; }
      const item: ReviewItem = { id: id(), state: "under_review", reason: i.reason, created_at: iso(), updated_at: iso(), topic_id: i.topic_id, theme: i.theme, first_week: i.first_week, created_by: i.created_by };
      s.items.push(item); return { item, created: true };
    },
    async setState(i, state: ReviewState) { const it = s.items.find((x) => x.id === i); if (!it) return null; it.state = state; return it; },
    async listVotes(i) { return s.votes.filter((v) => !i || v.item_id === i); },
    async upsertVote(i, voter, choice: Choice) {
      const ex = s.votes.find((v) => v.item_id === i && v.voter === voter);
      if (ex) { ex.choice = choice; ex.updated_at = iso(); } else s.votes.push({ item_id: i, voter, choice, updated_at: iso() });
    },
    async deleteVote(i, voter) { const l = s.votes.length; s.votes = s.votes.filter((v) => !(v.item_id === i && v.voter === voter)); return s.votes.length < l; },
    async clearVotes(i) { const l = s.votes.length; s.votes = s.votes.filter((v) => v.item_id !== i); return l - s.votes.length; },
    async listDecisions(i) { return s.decisions.filter((d) => !i || d.item_id === i).sort((a, b) => b.id - a.id); },
    async recordDecision(d) {
      const it = s.items.find((x) => x.id === d.item_id); if (!it) throw new Error("review item not found");
      for (const o of s.decisions) if (o.item_id === d.item_id && !o.superseded_at) o.superseded_at = iso();
      const row: Decision = { id: s.decisions.length + 1, decided_at: iso(), superseded_at: null, ...d };
      s.decisions.push(row); it.state = d.outcome;
      s.events.push({ id: s.events.length + 1, at: iso(), item_id: d.item_id, actor: d.decided_by, action: "decision_recorded", detail: { decision_id: row.id, outcome: d.outcome } });
      return row.id;
    },
    async addEvent(e) { s.events.push({ id: s.events.length + 1, at: iso(), item_id: e.item_id, actor: e.actor, action: e.action, detail: e.detail ?? null }); },
    async listManualEmailEvents(w, limit) { return s.events.filter((e) => e.item_id === null && (e.action === "email_sent_manual" || e.action === "email_resent_manual") && (e.detail as { weekStart?: string } | null)?.weekStart === w).reverse().slice(0, limit).map((e) => ({ at: e.at, action: e.action as "email_sent_manual" | "email_resent_manual" })); },
    async listEvents(i, limit) { return s.events.filter((e) => e.item_id === i).reverse().slice(0, limit); },

    async getDerivedAnalysis(w) { return s.derived.filter((d) => d.week_start === w).sort((a, b) => b.method_version - a.method_version)[0] ?? null; },
    async saveDerivedAnalysis(a) {
      if (s.derived.some((d) => d.week_start === a.week_start && d.method_version === a.method_version)) return null;
      const row: DerivedAnalysis = { id: id(), created_at: iso(), ...a }; s.derived.push(row); return row;
    },

    async savePack(p) { const row: PackRow = { id: id(), created_at: iso(), ...p }; s.packs.push(row); return row; },
    async latestPack() { return s.packs[s.packs.length - 1] ?? null; },

    async claimAlert(key, kind) { if (s.alerts.some((a) => a.key === key)) return false; s.alerts.push({ key, kind, at: new Date() }); return true; },
    async releaseAlert(key) { s.alerts = s.alerts.filter((a) => a.key !== key); },
    async countAlerts(kind, since) { return s.alerts.filter((a) => a.kind === kind && a.at >= since).length; },

  };
  return { store, state: s };
}
