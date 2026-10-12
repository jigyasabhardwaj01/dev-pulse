import { NextResponse } from "next/server";
import { clearCookie, sameOrigin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL("/signin", req.url), { status: 303, headers: { "cache-control": "no-store" } });
  if (sameOrigin(req)) res.headers.append("set-cookie", clearCookie(new URL(req.url).protocol === "https:"));
  return res;
}
