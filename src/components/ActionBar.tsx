"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Readiness } from "@/lib/email-summary";
import type { ResearchResult } from "@/lib/research";

const fmt = (iso: string | null) => (iso ? `${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)).replace(",", "")} IST` : "");
const post = async (url: string, body?: unknown) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
};

/** Start Research: runs the real workflow, then follows the newest run until it is truly finished. Success is shown only when every step worked. */
function StartResearch({ blocked, running }: { blocked: string | null; running: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "starting" | "polling" | "done">(running ? "polling" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const since = useRef<number | null>(null);
  const t0 = useRef<number>(Date.now());

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/research/status${since.current ? `?since=${since.current}` : ""}`, { cache: "no-store", credentials: "same-origin" });
      const data = (await res.json()) as ResearchResult & { error?: string };
      if (!res.ok) return;
      setResult(data);
      if (data.state === "success" || data.state === "problems" || data.state === "failed") { setPhase("done"); router.refresh(); }
    } catch { /* keep trying: the connection may have dropped for a moment */ }
  }, [router]);

  useEffect(() => {
    if (phase !== "polling") return;
    const id = setInterval(() => { setElapsed(Math.round((Date.now() - t0.current) / 1000)); void poll(); }, 4000);
    return () => clearInterval(id);
  }, [phase, poll]);
  useEffect(() => {
    if (phase === "polling" && elapsed > 6 * 60) { setPhase("done"); setError("This is taking longer than expected. It may still be running: open Settings & Diagnostics → Technical status to check."); }
  }, [elapsed, phase]);

  async function start() {
    setError(null); setResult(null); setPhase("starting");
    try {
      const r = await post("/api/research/start");
      if (!r.ok) { setError((r.data.error as string) ?? "Research could not be started. Nothing was changed."); setPhase("idle"); return; }
      since.current = Date.parse(String(r.data.startedAt)) || Date.now(); t0.current = Date.now(); setElapsed(0); setPhase("polling");
    } catch { setError("Could not reach the server. Nothing was changed."); setPhase("idle"); }
  }
  const busy = phase === "starting" || phase === "polling";
  return (
    <div className="action-box">
      <button className="btn primary" type="button" onClick={start} disabled={busy || Boolean(blocked)} aria-describedby="research-help">{busy ? "Research is running…" : "Start Research"}</button>
      <p id="research-help" className="muted small">{blocked ?? "Collects new discussions, analyses them with AI and saves this week's report. Takes a few minutes. It does not send any email."}</p>
      {busy && <p role="status" className="small"><strong>Research is running{elapsed ? ` (${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, "0")}s)` : ""}.</strong> It collects discussions, analyses them with AI and saves the report. You can leave this page open; it updates by itself.</p>}
      {error && <p role="alert" className="notice-err small">{error}</p>}
      {phase === "done" && result && (
        <div role="status" className={`result ${result.state === "success" ? "ok" : result.state === "failed" ? "bad" : "warn"}`}>
          <strong>{result.headline}</strong>
          <ul>{result.lines.map((l) => <li key={l.headline}><strong>{l.headline}.</strong> {l.detail}</li>)}</ul>
          {result.todo && <p>{result.todo}</p>}
        </div>
      )}
    </div>
  );
}

/** Email Summary: shows who it will go to, asks first, and reports only what the email provider actually confirmed. */
function EmailSummary({ r }: { r: Readiness }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [again, setAgain] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const nonce = useRef<string>("");
  const already = r.alreadySentAt !== null;

  function ask() { nonce.current = crypto.randomUUID(); setAgain(false); setError(null); setDone(null); setOpen(true); }
  async function send() {
    setPending(true); setError(null);
    try {
      const res = await post("/api/email/summary", { weekStart: r.weekStart, confirm: true, resend: already && again, nonce: nonce.current });
      if (!res.ok) { setError((res.data.error as string) ?? "The email was not sent."); return; }
      setDone(`${res.data.outcome === "resent" ? "A second copy was" : "The email was"} accepted by the email provider at ${fmt(String(res.data.at))} for ${String(res.data.recipient)}. That means it was handed over for delivery; it normally reaches the inbox within a minute.`);
      setOpen(false); router.refresh();
    } catch { setError("Could not reach the server. Nothing was sent."); } finally { setPending(false); }
  }
  return (
    <div className="action-box">
      <button className="btn" type="button" onClick={ask} disabled={!r.ready || pending || open} aria-describedby="email-help">Email Summary</button>
      <p id="email-help" className="muted small">{r.ready ? `Emails the saved report for ${r.periodLabel} to ${r.recipient}. You will be asked to confirm.` : r.reason}</p>
      {r.lastManual && !done && <p className="muted small">Last copy sent from this button: {fmt(r.lastManual.at)}{r.lastManual.kind === "resent" ? " (a second copy)" : ""}.</p>}
      {open && (
        <div className="confirm" role="dialog" aria-label="Confirm sending the email">
          <p><strong>Send the report for {r.periodLabel} to {r.recipient}?</strong></p>
          <p className="muted small">It includes the key insights, the top problems with their evidence links, and suggested next steps, exactly as saved.</p>
          {already && (
            <div className="warn-box">
              <p><strong>This report was already emailed{r.alreadySentAt ? ` on ${fmt(r.alreadySentAt)}` : ""}.</strong> Sending it again delivers a second copy.</p>
              <label className="check"><input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} /> Yes, I want a second copy of this report</label>
            </div>
          )}
          <div className="actions">
            <button className="btn primary" type="button" onClick={send} disabled={pending || (already && !again)}>{pending ? "Sending…" : already ? "Send a second copy" : "Send email"}</button>
            <button className="btn" type="button" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="notice-err small">{error}</p>}
      {done && <p role="status" className="notice-ok small">{done}</p>}
    </div>
  );
}

export default function ActionBar({ research, email }: { research: { blocked: string | null; running: boolean }; email: Readiness }) {
  return <section className="action-bar" aria-label="Manual controls"><StartResearch {...research} /><EmailSummary r={email} /></section>;
}
