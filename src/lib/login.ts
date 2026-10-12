import { ATTEMPTS_PER_WINDOW, ATTEMPT_WINDOW_MS, MIN_PASSCODE, isEmail, passcodeMatches, roleOf, rosterFromEnv, sessionToken } from "./auth";
import { newNonceForLog } from "./login-log";
import type { TeamStore } from "./team-store";

/*
 * Passcode sign-in. The roster decides WHO may sign in and with which role; the passcode for that role proves it. Nothing is
 * emailed. Wrong attempts are logged per address and bounded, so a passcode cannot be guessed at speed. Every refusal gives the
 * same message, so the response never reveals whether an address is on the roster.
 */
export const REFUSED = "That email and passcode do not match.";

export async function login(
  team: TeamStore, emailRaw: unknown, passcode: unknown, env: NodeJS.ProcessEnv = process.env, now = new Date(),
): Promise<{ status: number; message?: string; cookie?: string }> {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 16 || !(env.OWNER_PASSCODE && env.OWNER_PASSCODE.length >= MIN_PASSCODE)) return { status: 503, message: "Sign-in is not configured on this deployment." };
  if (!isEmail(emailRaw) || typeof passcode !== "string" || !passcode || passcode.length > 200) return { status: 400, message: "Enter your team email and passcode." };
  const email = emailRaw.trim().toLowerCase();
  try {
    if ((await team.countTokens(email, new Date(now.getTime() - ATTEMPT_WINDOW_MS))) >= ATTEMPTS_PER_WINDOW) return { status: 429, message: "Too many attempts. Try again in 15 minutes." };
    const role = roleOf(email, rosterFromEnv(env));
    const ok = role === "owner" ? passcodeMatches(passcode, env.OWNER_PASSCODE) : role === "member" ? passcodeMatches(passcode, env.TEAM_PASSCODE) : false;
    if (!ok) {
      await team.createToken(newNonceForLog(), email, new Date(now.getTime() + ATTEMPT_WINDOW_MS)); // the failed attempt, counted per address
      return { status: 401, message: REFUSED };
    }
    return { status: 200, cookie: sessionToken(email, secret, now.getTime()) };
  } catch {
    return { status: 503, message: "Sign-in is temporarily unavailable. Nothing was changed." };
  }
}
