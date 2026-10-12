import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Sign-in for the review workflow. There are no passwords and no accounts table: a person is whoever the ROSTER (server
 * environment) names, and proves it by opening a single-use link sent to that address. The browser then holds an HMAC-signed,
 * httpOnly session cookie that carries only the email and an expiry. The ROLE is never stored in the cookie and never sent by
 * the client: it is derived from the roster on every request, so removing someone from the roster takes effect immediately.
 */
export type Role = "owner" | "member";
export interface Roster { owner: string | null; members: string[] }
export interface Session { email: string; role: Role }

export const SESSION_COOKIE = "jarvis_session";
export const SESSION_TTL_S = 7 * 24 * 3600;
export const LINK_TTL_S = 15 * 60;
export const LINKS_PER_WINDOW = 3;
export const LINK_WINDOW_MS = 15 * 60_000;

const normEmail = (s: string) => s.trim().toLowerCase();
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
export const isEmail = (s: unknown): s is string => typeof s === "string" && s.length <= 254 && EMAIL.test(s.trim());

/** The owner is JARVIS_OWNER_EMAIL, else the approved report recipient. Team members come from JARVIS_TEAM_EMAILS (comma separated). */
export function rosterFromEnv(env: NodeJS.ProcessEnv = process.env): Roster {
  const ownerRaw = env.JARVIS_OWNER_EMAIL || env.DIGEST_TO_EMAIL || "";
  const owner = isEmail(ownerRaw) ? normEmail(ownerRaw) : null;
  const members = (env.JARVIS_TEAM_EMAILS ?? "").split(",").map(normEmail).filter((e) => isEmail(e) && e !== owner);
  return { owner, members: [...new Set(members)] };
}

export function roleOf(email: string, roster: Roster): Role | null {
  const e = normEmail(email);
  if (roster.owner && e === roster.owner) return "owner";
  return roster.members.includes(e) ? "member" : null;
}

// ---------------------------------------------------------------------------------------------------------------------------
type Payload = { k: "s" | "l"; e: string; x: number; n?: string };
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest();

export function sign(p: Payload, secret: string): string {
  const body = b64(JSON.stringify(p));
  return `${body}.${b64(mac(body, secret))}`;
}
export function verify(token: unknown, secret: string | undefined, kind: Payload["k"], nowMs: number): Payload | null {
  if (!secret || secret.length < 16 || typeof token !== "string" || token.length > 2000) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const want = mac(body, secret);
  let got: Buffer;
  try { got = Buffer.from(sig, "base64url"); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    if (p.k !== kind || typeof p.e !== "string" || typeof p.x !== "number" || p.x * 1000 <= nowMs) return null;
    return p;
  } catch { return null; }
}

export const newNonce = () => randomBytes(18).toString("base64url");
export const sessionToken = (email: string, secret: string, nowMs: number) => sign({ k: "s", e: normEmail(email), x: Math.floor(nowMs / 1000) + SESSION_TTL_S }, secret);
export const linkToken = (email: string, nonce: string, secret: string, nowMs: number) => sign({ k: "l", e: normEmail(email), n: nonce, x: Math.floor(nowMs / 1000) + LINK_TTL_S }, secret);

export function cookieValue(header: string | null | undefined, name = SESSION_COOKIE): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The signed-in person for a request, or null. Role comes from the roster NOW, not from anything the client sent. */
export function sessionFrom(cookieHeader: string | null | undefined, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): Session | null {
  const p = verify(cookieValue(cookieHeader), env.SESSION_SECRET, "s", nowMs);
  if (!p) return null;
  const role = roleOf(p.e, rosterFromEnv(env));
  return role ? { email: normEmail(p.e), role } : null;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_S}${secure ? "; Secure" : ""}`;
}
export const clearCookie = (secure: boolean) => `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;

/**
 * CSRF defence for every state-changing request: the browser must say the request comes from this site (Origin header equal to the
 * request's own origin or the configured APP_URL) AND send JSON (which a cross-site form cannot do without a CORS preflight).
 */
export function sameOriginJson(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set([new URL(req.url).origin]);
  if (env.APP_URL) { try { allowed.add(new URL(env.APP_URL).origin); } catch { /* ignore a malformed APP_URL */ } }
  if (!allowed.has(origin)) return false;
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}
/** Same origin check for the sign-in confirmation form (a browser form post, not JSON). */
export function sameOrigin(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set([new URL(req.url).origin]);
  if (env.APP_URL) { try { allowed.add(new URL(env.APP_URL).origin); } catch { /* ignore */ } }
  return allowed.has(origin);
}
