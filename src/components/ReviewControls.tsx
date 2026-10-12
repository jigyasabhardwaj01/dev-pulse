"use client";

import { useState } from "react";
import { NoticeLine, useAction } from "./useAction";

export function ShortlistButton({ weekStart, topicId, theme }: { weekStart: string; topicId: string; theme: string }) {
  const { run, pending, notice } = useAction();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) return <button className="btn btn-sm" type="button" onClick={() => setOpen(true)}>Shortlist<span className="sr-only"> “{theme}” for review</span></button>;
  return (
    <form className="stack-sm" onSubmit={async (e) => { e.preventDefault(); if (await run("POST", "/api/review/items", { weekStart, topicId, theme, reason }, "Shortlisted. Find it under Review & Decisions.")) { setOpen(false); setReason(""); } }}>
      <label className="small" htmlFor={`why-${topicId}-${theme}`}>Why should the team review “{theme}”?</label>
      <input id={`why-${topicId}-${theme}`} className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required minLength={3} />
      <span className="row-wrap">
        <button className="btn btn-sm primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Add to review"}</button>
        <button className="btn btn-sm" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </span>
      <NoticeLine notice={notice} />
    </form>
  );
}

export function VoteControls({ itemId, mine }: { itemId: string; mine: "prioritise" | "park" | null }) {
  const { run, pending, notice } = useAction();
  return (
    <div className="stack-sm">
      <div className="row-wrap" role="group" aria-label="Your vote">
        {(["prioritise", "park"] as const).map((c) => (
          <button key={c} className={`btn btn-sm${mine === c ? " primary" : ""}`} type="button" aria-pressed={mine === c} disabled={pending} onClick={() => run("PUT", `/api/review/items/${itemId}/vote`, { choice: c }, `Vote recorded: ${c}.`)}>
            {c === "prioritise" ? "Prioritise" : "Park"}
          </button>
        ))}
        {mine && <button className="btn btn-sm" type="button" disabled={pending} onClick={() => run("DELETE", `/api/review/items/${itemId}/vote`, undefined, "Vote withdrawn.")}>Withdraw vote</button>}
      </div>
      <NoticeLine notice={notice} />
    </div>
  );
}

export function OwnerControls({ itemId, state }: { itemId: string; state: string }) {
  const { run, pending, notice } = useAction();
  const [outcome, setOutcome] = useState("prioritised");
  const [rationale, setRationale] = useState("");
  const [followup, setFollowup] = useState(false);
  return (
    <div className="stack-sm owner-box">
      <p className="small muted" style={{ margin: 0 }}>Owner controls</p>
      <div className="row-wrap">
        {state !== "open_for_votes"
          ? <button className="btn btn-sm" type="button" disabled={pending} onClick={() => run("PUT", `/api/review/items/${itemId}/state`, { state: "open_for_votes" }, "Voting opened.")}>Open for votes</button>
          : <button className="btn btn-sm" type="button" disabled={pending} onClick={() => run("PUT", `/api/review/items/${itemId}/state`, { state: "under_review" }, "Voting closed.")}>Close voting</button>}
      </div>
      <form className="stack-sm" onSubmit={async (e) => { e.preventDefault(); if (await run("POST", `/api/review/items/${itemId}/decision`, { outcome, rationale, followup }, "Decision recorded.")) setRationale(""); }}>
        <label className="small" htmlFor={`outcome-${itemId}`}>Decision</label>
        <select id={`outcome-${itemId}`} className="input" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="prioritised">Prioritise</option><option value="parked">Park</option><option value="rejected">Reject</option><option value="already_addressed">Already addressed</option>
        </select>
        <label className="small" htmlFor={`rationale-${itemId}`}>Rationale (required, kept in the record)</label>
        <textarea id={`rationale-${itemId}`} className="input" rows={2} maxLength={1000} required value={rationale} onChange={(e) => setRationale(e.target.value)} />
        <label className="small row-wrap" style={{ gap: 6 }}><input type="checkbox" checked={followup} onChange={(e) => setFollowup(e.target.checked)} /> Needs a follow-up</label>
        <button className="btn btn-sm primary" type="submit" disabled={pending}>{pending ? "Recording…" : "Record decision"}</button>
      </form>
      <NoticeLine notice={notice} />
    </div>
  );
}

export function DeriveButton({ weekStart }: { weekStart: string }) {
  const { run, pending, notice } = useAction();
  return (
    <span className="stack-sm">
      <button className="btn btn-sm" type="button" disabled={pending} onClick={() => run("POST", "/api/analysis", { weekStart }, "Analysis derived from stored evidence.")}>{pending ? "Deriving…" : "Derive analysis from stored evidence"}</button>
      <NoticeLine notice={notice} />
    </span>
  );
}

export function WithdrawButton({ itemId, theme }: { itemId: string; theme: string }) {
  const { run, pending, notice } = useAction();
  return (
    <span className="stack-sm">
      <button className="btn btn-sm" type="button" disabled={pending} onClick={() => run("DELETE", `/api/review/items/${itemId}`, undefined, "Withdrawn from review.")}>Unshortlist<span className="sr-only"> “{theme}”</span></button>
      <NoticeLine notice={notice} />
    </span>
  );
}
