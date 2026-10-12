"use client";

import { useState } from "react";
import { NoticeLine, useAction } from "./useAction";

export function AddTermForm({ topicId, topicName, includes }: { topicId: string; topicName: string; includes: { id: string; term: string }[] }) {
  const { run, pending, notice } = useAction();
  const [term, setTerm] = useState("");
  const [kind, setKind] = useState<"include" | "exclude">("include");
  const [scope, setScope] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (await run("POST", "/api/watchlist/terms", { topicId, term, kind, appliesTo: kind === "exclude" && scope ? scope : undefined }, "Added.")) setTerm("");
  }
  return (
    <form onSubmit={submit} className="stack-sm" aria-label={`Add a term to ${topicName}`}>
      <div className="row-wrap">
        <label className="sr-only" htmlFor={`term-${topicId}`}>New term for {topicName}</label>
        <input id={`term-${topicId}`} className="input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="e.g. flaky tests" maxLength={80} required />
        <label className="sr-only" htmlFor={`kind-${topicId}`}>Kind</label>
        <select id={`kind-${topicId}`} className="input" value={kind} onChange={(e) => setKind(e.target.value as "include" | "exclude")}>
          <option value="include">Watch for</option><option value="exclude">Exclude</option>
        </select>
        {kind === "exclude" && (
          <>
            <label className="sr-only" htmlFor={`scope-${topicId}`}>Apply exclusion to</label>
            <select id={`scope-${topicId}`} className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Whole topic</option>
              {includes.map((i) => <option key={i.id} value={i.id}>Only “{i.term}”</option>)}
            </select>
          </>
        )}
        <button className="btn" type="submit" disabled={pending}>{pending ? "Adding…" : "Add"}</button>
      </div>
      <NoticeLine notice={notice} />
    </form>
  );
}

export function TermActions({ id, term, status }: { id: string; term: string; status: "active" | "paused" }) {
  const { run, pending, notice } = useAction();
  const [confirm, setConfirm] = useState(false);
  return (
    <span className="row-wrap">
      <button className="btn btn-sm" type="button" disabled={pending} onClick={() => run("PATCH", `/api/watchlist/terms/${id}`, { status: status === "active" ? "paused" : "active" }, status === "active" ? "Paused." : "Resumed.")}>
        {status === "active" ? "Pause" : "Resume"}<span className="sr-only"> “{term}”</span>
      </button>
      {confirm ? (
        <>
          <button className="btn btn-sm btn-danger" type="button" disabled={pending} onClick={async () => { if (!(await run("DELETE", `/api/watchlist/terms/${id}`, undefined, "Removed."))) setConfirm(false); }}>Confirm remove<span className="sr-only"> “{term}”</span></button>
          <button className="btn btn-sm" type="button" onClick={() => setConfirm(false)}>Cancel</button>
        </>
      ) : <button className="btn btn-sm" type="button" disabled={pending} onClick={() => setConfirm(true)}>Remove<span className="sr-only"> “{term}”</span></button>}
      <NoticeLine notice={notice} />
    </span>
  );
}

export function SensitivityForm({ value, options }: { value: string; options: { value: string; label: string; help: string }[] }) {
  const { run, pending, notice } = useAction();
  return (
    <fieldset className="stack-sm" disabled={pending} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="sr-only">Detection mode</legend>
      {options.map((o) => (
        <label key={o.value} className="card card-pad radio-card">
          <input type="radio" name="sensitivity" value={o.value} checked={value === o.value} onChange={() => run("PUT", "/api/watchlist/sensitivity", { sensitivity: o.value }, `Mode set to ${o.label}. It applies from the next run.`)} />
          <span><strong>{o.label}</strong><span className="muted small" style={{ display: "block" }}>{o.help}</span></span>
        </label>
      ))}
      <NoticeLine notice={notice} />
    </fieldset>
  );
}
