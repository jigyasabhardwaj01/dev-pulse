import { NextResponse } from "next/server";
import { sameOrigin, sessionCookie } from "@/lib/auth";
import { confirmLink } from "@/lib/auth-flow";
import { makeSupabaseTeamStore } from "@/lib/team-store";

export const dynamic = "force-dynamic";

/** The confirmation form posts here. GET is deliberately not supported, so a mail scanner fetching the link cannot use it up. */
export async function POST(req: Request) {
  const back = (q: string) => NextResponse.redirect(new URL(`/signin${q}`, req.url), { status: 303, headers: { "cache-control": "no-store" } });
  if (!sameOrigin(req)) return back("?error=origin");
  const form = await req.formData().catch(() => null);
  const token = form?.get("token");
  const cookie = typeof token === "string" ? await confirmLink(makeSupabaseTeamStore(), token).catch(() => null) : null;
  if (!cookie) return back("?error=invalid");
  const res = NextResponse.redirect(new URL("/review", req.url), { status: 303, headers: { "cache-control": "no-store" } });
  res.headers.append("set-cookie", sessionCookie(cookie, new URL(req.url).protocol === "https:"));
  return res;
}
