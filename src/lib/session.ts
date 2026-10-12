import { cookies } from "next/headers";
import { VISITOR_COOKIE, visitorFrom, type Session } from "./auth";

/** The current visitor for a page render. A first-time visitor has no id yet (one is issued on their first write); they may still use every control. */
export async function currentSession(): Promise<Session> {
  const v = (await cookies()).get(VISITOR_COOKIE)?.value;
  return (v ? visitorFrom(null, v) : null) ?? { email: "visitor", role: "owner" };
}
