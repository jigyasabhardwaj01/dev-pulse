import { randomBytes } from "node:crypto";

/*
 * JARVIS has no login. Everyone who can open the site can read AND use the review tools (watchlist, shortlist, votes, decisions,
 * Monday pack). Nothing secret protects them: there are no passcodes, no roster and no sessions.
 *
 * What remains is bookkeeping, not security:
 *  - a random per-browser visitor id (cookie), so "one vote per person" and "who recorded this" still mean something. It is
 *    anonymous, can be cleared or changed by the visitor, and proves nothing about who they are;
 *  - a same-origin + JSON check on every write, so another website cannot make a visitor's browser submit changes (CSRF).
 */
export type Role = "owner" | "member";
export interface Session { email: string; role: Role }

export const VISITOR_COOKIE = "jarvis_visitor";
const VISITOR_ID = /^[a-f0-9]{24}$/;

export const newVisitorId = () => randomBytes(12).toString("hex");

export function cookieValue(header: string | null | undefined, name = VISITOR_COOKIE): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The visitor behind a request, from their id cookie. Every visitor may use every tool, so the role is always "owner". */
export function visitorFrom(cookieHeader: string | null | undefined, id: string | null = cookieValue(cookieHeader)): Session | null {
  return id && VISITOR_ID.test(id) ? { email: `visitor-${id}`, role: "owner" } : null;
}

export const visitorCookie = (id: string, secure: boolean) => `${VISITOR_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${365 * 24 * 3600}${secure ? "; Secure" : ""}`;

/** CSRF defence for every write: the browser must say the request comes from this site (Origin) AND send JSON (needs a CORS preflight cross-site). */
export function sameOriginJson(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set([new URL(req.url).origin]);
  if (env.APP_URL) { try { allowed.add(new URL(env.APP_URL).origin); } catch { /* ignore a malformed APP_URL */ } }
  if (!allowed.has(origin)) return false;
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}
