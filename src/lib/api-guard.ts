import { NextResponse } from "next/server";
import { sameOriginJson, sessionFrom, type Role, type Session } from "./auth";
import { makeSupabaseTeamStore, type TeamStore } from "./team-store";
import { makeSupabaseStore } from "./store";
import { sanitizeError } from "./text";
import type { PainPointLookup } from "./team";

const NO_STORE = { "cache-control": "no-store" };
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * Every write endpoint goes through here: same-origin JSON only (CSRF), a valid signed session, and the required role, all checked
 * on the server. There is no unauthenticated write endpoint and nothing the browser sends can name the actor or grant a role.
 */
export async function guarded(
  req: Request, need: Role | "member", run: (s: Session, team: TeamStore, body: Record<string, unknown>) => Promise<Response>, opts: { body?: boolean } = {},
): Promise<Response> {
  if (!sameOriginJson(req)) return json({ error: "Request must come from this site as JSON." }, 403);
  const session = sessionFrom(req.headers.get("cookie"));
  if (!session) return json({ error: "Sign in to continue." }, 401);
  if (need === "owner" && session.role !== "owner") return json({ error: "Only the owner can do this." }, 403);
  let body: Record<string, unknown> = {};
  if (opts.body !== false) {
    try { const b = await req.json(); body = b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {}; } catch { return json({ error: "Invalid JSON." }, 400); }
  }
  try {
    return await run(session, makeSupabaseTeamStore(), body);
  } catch (e) {
    console.error("team api failed:", sanitizeError(e));
    return json({ error: "Something went wrong. Nothing was changed unless a success message was shown." }, 500);
  }
}

/** Resolves a pain point in the SAVED report's sealed analysis, so only real ones can be shortlisted. */
export const savedPainPointLookup: PainPointLookup = async (weekStart, topicId, theme) => {
  const brief = await makeSupabaseStore().getBrief(weekStart);
  const p = brief?.analysis?.painPoints.find((x) => x.topic_id === topicId && x.theme === theme);
  return p ? { links: p.links, discussions: p.discussions } : null;
};
