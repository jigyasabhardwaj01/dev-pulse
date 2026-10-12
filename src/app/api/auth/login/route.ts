import { NextResponse } from "next/server";
import { sameOriginJson, sessionCookie } from "@/lib/auth";
import { login } from "@/lib/login";
import { makeSupabaseTeamStore } from "@/lib/team-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const headers = { "cache-control": "no-store" };
  if (!sameOriginJson(req)) return NextResponse.json({ error: "Request must come from this site as JSON." }, { status: 403, headers });
  let body: { email?: unknown; passcode?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400, headers }); }
  const r = await login(makeSupabaseTeamStore(), body.email, body.passcode);
  if (!r.cookie) return NextResponse.json({ error: r.message }, { status: r.status, headers });
  const res = NextResponse.json({ ok: true }, { status: 200, headers });
  res.headers.append("set-cookie", sessionCookie(r.cookie, new URL(req.url).protocol === "https:"));
  return res;
}
