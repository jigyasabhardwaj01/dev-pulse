"use client";

import { useState } from "react";

export default function SignInForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "busy" | "done" | "error"; text?: string }>({ kind: "idle" });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: "busy" });
    try {
      const res = await fetch("/api/auth/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      setState(res.ok ? { kind: "done", text: data.message } : { kind: "error", text: data.message ?? data.error ?? "Could not send a link." });
    } catch { setState({ kind: "error", text: "Could not reach the server." }); }
  }
  return (
    <form onSubmit={submit} className="card card-pad stack" style={{ maxWidth: 460 }}>
      <label htmlFor="signin-email"><strong>Team email</strong></label>
      <input id="signin-email" className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@team.example" />
      <button className="btn primary" type="submit" disabled={state.kind === "busy"}>{state.kind === "busy" ? "Sending…" : "Email me a sign-in link"}</button>
      <div role="status" aria-live="polite" className="small">{state.text && <span className={state.kind === "error" ? "notice-err" : "muted"}>{state.text}</span>}</div>
    </form>
  );
}
