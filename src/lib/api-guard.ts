import { NextResponse } from "next/server";
import { cookieValue, newVisitorId, sameOriginJson, visitorCookie, visitorFrom, type Role, type Session } from "./auth";
import { makeSupabaseTeamStore, type TeamStore } from "./team-store";
import { makeSupabaseStore } from "./store";
import { sanitizeError } from "./text";
import type { PainPointLookup } from "./team";
import { analysisFor } from "./analysis-source";

const NO_STORE = { "cache-control": "no-store" };
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * Every write endpoint goes through here. There is no login (by decision): any visitor may use every tool. What is still enforced is
 * same-origin JSON (CSRF), and that the actor is the visitor id cookie, never a name sent in the request body.
 */
export async function guarded(
  req: Request, _need: Role | "member", run: (s: Session, team: TeamStore, body: Record<string, unknown>) => Promise<Response>, opts: { body?: boolean } = {},
): Promise<Response> {
  if (!sameOriginJson(req)) return json({ error: "Request must come from this site as JSON." }, 403);
  // No login: any visitor may write. A visitor id (cookie) identifies the browser for "one vote per person" and the audit trail.
  const existing = cookieValue(req.headers.get("cookie"));
  const id = existing && visitorFrom(null, existing) ? existing : newVisitorId();
  const visitor = visitorFrom(null, id)!;
  let body: Record<string, unknown> = {};
  if (opts.body !== false) {
    try { const b = await req.json(); body = b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {}; } catch { return json({ error: "Invalid JSON." }, 400); }
  }
  let res: Response;
  try {
    res = await run(visitor, makeSupabaseTeamStore(), body);
  } catch (e) {
    console.error("team api failed:", sanitizeError(e));
    res = json({ error: "Something went wrong. Nothing was changed unless a success message was shown." }, 500);
  }
  if (id !== existing) res.headers.append("set-cookie", visitorCookie(id, new URL(req.url).protocol === "https:"));
  return res;
}

/** Resolves a pain point in the SAVED report's sealed analysis, so only real ones can be shortlisted. */
export const savedPainPointLookup: PainPointLookup = async (weekStart, topicId, theme) => {
  const a = await analysisFor(makeSupabaseStore(), makeSupabaseTeamStore(), weekStart);
  const p = a.kind === "none" ? undefined : a.analysis.painPoints.find((x) => x.topic_id === topicId && x.theme === theme);
  return p ? { links: p.links, discussions: p.discussions } : null;
};
