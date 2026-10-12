"use client";

import { useState } from "react";
import { NoticeLine, useAction } from "./useAction";

const CHOICES = [
  { v: "prioritised", label: "Work on this", hint: "It goes to the top of the Weekly Action Plan." },
  { v: "parked", label: "Not now", hint: "Real, but not this week. It stays on record." },
  { v: "already_addressed", label: "Already handled", hint: "We have dealt with this already." },
  { v: "rejected", label: "Not a problem for us", hint: "It does not apply to our work." },
] as const;

export function ShortlistForm({ weekStart, topicId, theme }: { weekStart: string; topicId: string; theme: string }) {
  const { run, pending, notice } = useAction();
  const [reason, setReason] = useState("");
  return (
    <form className="stack" onSubmit={async (e) => { e.preventDefault(); if (await run("POST", "/api/review/items", { weekStart, topicId, theme, reason }, "Shortlisted. You can now record a decision.")) setReason(""); }}>
      <div className="field">
        <label htmlFor="why">Why does this deserve your team&rsquo;s time?</label>
        <input id="why" className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} minLength={3} required placeholder="For example: we hit this last sprint" />
      </div>
      <div className="actions"><button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Shortlist this problem"}</button></div>
      <p className="muted small">Shortlisting only adds it to your list. Nothing is decided yet and nobody is notified.</p>
      <NoticeLine notice={notice} />
    </form>
  );
}

export function DecisionForm({ itemId, current }: { itemId: string; current: string | null }) {
  const { run, pending, notice } = useAction();
  const [outcome, setOutcome] = useState<string>(current ?? "prioritised");
  const [rationale, setRationale] = useState("");
  const [followup, setFollowup] = useState(false);
  return (
    <form className="stack" onSubmit={async (e) => { e.preventDefault(); if (await run("POST", `/api/review/items/${itemId}/decision`, { outcome, rationale, followup }, "Decision recorded. It now appears in the Weekly Action Plan.")) setRationale(""); }}>
      <fieldset className="radios">
        <legend className="small" style={{ fontWeight: 650, marginBottom: 6 }}>What will your team do?</legend>
        {CHOICES.map((c) => (
          <label key={c.v}><input type="radio" name={`o-${itemId}`} value={c.v} checked={outcome === c.v} onChange={() => setOutcome(c.v)} /><span>{c.label}<small>{c.hint}</small></span></label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={`r-${itemId}`}>Why? (kept with the decision)</label>
        <textarea id={`r-${itemId}`} className="input" rows={2} maxLength={1000} required value={rationale} onChange={(e) => setRationale(e.target.value)} />
      </div>
      <label className="check"><input type="checkbox" checked={followup} onChange={(e) => setFollowup(e.target.checked)} /> Someone needs to follow up on this</label>
      <div className="actions"><button className="btn primary" type="submit" disabled={pending}>{pending ? "Recording…" : current ? "Record a new decision" : "Record decision"}</button></div>
      <NoticeLine notice={notice} />
    </form>
  );
}

export function VotePanel({ itemId, open, mine, tally }: { itemId: string; open: boolean; mine: "prioritise" | "park" | null; tally: { prioritise: number; park: number } }) {
  const { run, pending, notice } = useAction();
  if (!open) {
    return (
      <div className="stack">
        <p className="muted small">Want advice first? Open voting and teammates can say &ldquo;Prioritise&rdquo; or &ldquo;Park&rdquo;. Votes are advice only; you still decide.</p>
        <div className="actions"><button className="btn" type="button" disabled={pending} onClick={() => run("PUT", `/api/review/items/${itemId}/state`, { state: "open_for_votes" }, "Voting is open.")}>Ask teammates to vote</button></div>
        <NoticeLine notice={notice} />
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="small">Votes so far: <strong>{tally.prioritise}</strong> prioritise, <strong>{tally.park}</strong> park. Advice only.</p>
      <div className="actions" role="group" aria-label="Your vote">
        {(["prioritise", "park"] as const).map((c) => (
          <button key={c} className={`btn${mine === c ? " primary" : ""}`} type="button" aria-pressed={mine === c} disabled={pending} onClick={() => run("PUT", `/api/review/items/${itemId}/vote`, { choice: c }, `Your vote is recorded: ${c}.`)}>{c === "prioritise" ? "I would prioritise it" : "I would park it"}</button>
        ))}
        {mine && <button className="btn" type="button" disabled={pending} onClick={() => run("DELETE", `/api/review/items/${itemId}/vote`, undefined, "Your vote is withdrawn.")}>Withdraw my vote</button>}
        <button className="btn" type="button" disabled={pending} onClick={() => run("PUT", `/api/review/items/${itemId}/state`, { state: "under_review" }, "Voting is closed.")}>Close voting</button>
      </div>
      <NoticeLine notice={notice} />
    </div>
  );
}

export function RemoveButton({ itemId }: { itemId: string }) {
  const { run, pending, notice } = useAction();
  return (
    <div className="stack">
      <div className="actions"><button className="btn" type="button" disabled={pending} onClick={() => run("DELETE", `/api/review/items/${itemId}`, undefined, "Removed from your shortlist.")}>Remove from shortlist</button></div>
      <NoticeLine notice={notice} />
    </div>
  );
}
