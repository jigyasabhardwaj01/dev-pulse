import type { Metadata } from "next";
import SignInForm from "@/components/SignInForm";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function SignIn() {
  const session = await currentSession();
  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Team access</p>
        <h1>Sign in</h1>
        <p className="lede">Reading reports needs no account. Shortlisting, voting and decisions are for the named team, and the owner makes the final calls. Sign in with your team email and passcode.</p>
      </header>
      {session ? (
        <div className="card card-pad stack" style={{ maxWidth: 460 }}>
          <p style={{ margin: 0 }}>Signed in as <strong>{session.email}</strong> <span className="pill neutral">{session.role}</span></p>
          <form method="post" action="/api/auth/signout"><button className="btn" type="submit">Sign out</button></form>
        </div>
      ) : <SignInForm />}
    </>
  );
}
