import { cookies } from "next/headers";
import { SESSION_COOKIE, sessionFrom, type Session } from "./auth";

/** The signed-in person for this page request (derived from the signed cookie and the roster), or null. */
export async function currentSession(): Promise<Session | null> {
  const v = (await cookies()).get(SESSION_COOKIE)?.value;
  return sessionFrom(v ? `${SESSION_COOKIE}=${v}` : null);
}
