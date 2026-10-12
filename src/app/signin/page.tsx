import type { Metadata } from "next";
import SignInForm from "@/components/SignInForm";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = { invalid: "That sign-in link is invalid, expired or already used. Request a new one.", origin: "That request did not come from this site, so it was refused." };

export default async function SignIn({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token, error } = await searchParams;
  const session = await currentSession();
  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Team access</p>
        <h1>Sign in</h1>
        <p className="lede">Reading reports needs no account. Shortlisting, voting and decisions are for the named team, and the owner makes the final calls. Sign-in is by a single-use link sent to your team email.</p>
      </header>
      {error && <p role="alert" className="alert warn">{ERRORS[error] ?? "Sign-in did not work."}</p>}
      {session ? (
        <div className="card card-pad stack" style={{ maxWidth: 460 }}>
          <p style={{ margin: 0 }}>Signed in as <strong>{session.email}</strong> <span className="pill neutral">{session.role}</span></p>
          <form method="post" action="/api/auth/signout"><button className="btn" type="submit">Sign out</button></form>
        </div>
      ) : token ? (
        <form method="post" action="/api/auth/verify" className="card card-pad stack" style={{ maxWidth: 460 }}>
          <p style={{ margin: 0 }}>Confirm to finish signing in on this device.</p>
          <input type="hidden" name="token" value={token} />
          <button className="btn primary" type="submit">Confirm sign-in</button>
        </form>
      ) : <SignInForm />}
    </>
  );
}
