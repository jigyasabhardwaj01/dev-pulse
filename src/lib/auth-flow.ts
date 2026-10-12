import { LINKS_PER_WINDOW, LINK_TTL_S, LINK_WINDOW_MS, isEmail, linkToken, newNonce, roleOf, rosterFromEnv, sessionToken, verify } from "./auth";
import type { TeamStore } from "./team-store";
import { sanitizeError } from "./text";
import type { FetchLike } from "./types";

/*
 * Magic-link sign-in. requestLink answers the same way whether or not the address is on the roster, so the page cannot be used to
 * discover who is on the team. The link opens a confirmation page (so an email scanner that merely fetches the link cannot use it
 * up); the confirmation POST consumes the single-use nonce and issues the session.
 */
export const GENERIC_SENT = "If that address is on the team, a sign-in link is on its way. It works once and expires in 15 minutes.";

export async function requestLink(team: TeamStore, emailRaw: unknown, env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch, now = new Date()): Promise<{ status: number; message: string }> {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 16 || !env.RESEND_API_KEY || !env.APP_URL) return { status: 503, message: "Sign-in is not configured on this deployment." };
  if (!isEmail(emailRaw)) return { status: 400, message: "Enter a valid email address." };
  const email = emailRaw.trim().toLowerCase();
  if (!roleOf(email, rosterFromEnv(env))) return { status: 200, message: GENERIC_SENT };
  try {
    if ((await team.countTokens(email, new Date(now.getTime() - LINK_WINDOW_MS))) >= LINKS_PER_WINDOW) return { status: 200, message: GENERIC_SENT }; // quietly bounded
    const nonce = newNonce();
    await team.createToken(nonce, email, new Date(now.getTime() + LINK_TTL_S * 1000));
    const url = `${env.APP_URL.replace(/\/+$/, "")}/signin?token=${encodeURIComponent(linkToken(email, nonce, secret, now.getTime()))}`;
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": `jarvis-signin-${nonce}` },
      body: JSON.stringify({ from: "JARVIS <onboarding@resend.dev>", to: [email], subject: "Your JARVIS sign-in link", html: `<p style="font-family:system-ui,sans-serif">Open this link to sign in to JARVIS. It works once and expires in 15 minutes.</p><p><a href="${url}">Sign in to JARVIS</a></p><p style="color:#666;font-size:.9em">If you did not ask for this, ignore this email.</p>` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`signin email not accepted: http ${res.status}`);
  } catch (e) {
    console.error("signin link failed:", sanitizeError(e));
  }
  return { status: 200, message: GENERIC_SENT };
}

/** Consumes the link and returns the session cookie value. Null for anything invalid, expired, reused, or no longer on the roster. */
export async function confirmLink(team: TeamStore, token: unknown, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<string | null> {
  const secret = env.SESSION_SECRET;
  const p = verify(token, secret, "l", now.getTime());
  if (!p || !p.n || !secret) return null;
  if (!roleOf(p.e, rosterFromEnv(env))) return null;
  const email = await team.consumeToken(p.n, now);
  if (!email || email !== p.e) return null;
  return sessionToken(email, secret, now.getTime());
}
