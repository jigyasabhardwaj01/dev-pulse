"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [passcode, setPasscode] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "busy" | "error"; text?: string }>({ kind: "idle" });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: "busy" });
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ email, passcode }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setState({ kind: "error", text: data.error ?? "Sign-in failed." }); return; }
      router.push("/review"); router.refresh();
    } catch { setState({ kind: "error", text: "Could not reach the server." }); }
  }
  return (
    <form onSubmit={submit} className="card card-pad stack" style={{ maxWidth: 460 }}>
      <label htmlFor="signin-email"><strong>Team email</strong></label>
      <input id="signin-email" className="input" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@team.example" />
      <label htmlFor="signin-pass"><strong>Passcode</strong></label>
      <input id="signin-pass" className="input" type="password" required autoComplete="current-password" value={passcode} onChange={(e) => setPasscode(e.target.value)} />
      <button className="btn primary" type="submit" disabled={state.kind === "busy"}>{state.kind === "busy" ? "Signing in…" : "Sign in"}</button>
      <div role="alert" aria-live="polite" className="small">{state.text && <span className="notice-err">{state.text}</span>}</div>
    </form>
  );
}
