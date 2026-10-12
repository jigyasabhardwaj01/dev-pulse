import { requestLink } from "@/lib/auth-flow";
import { sameOriginJson } from "@/lib/auth";
import { json } from "@/lib/api-guard";
import { makeSupabaseTeamStore } from "@/lib/team-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sameOriginJson(req)) return json({ error: "Request must come from this site as JSON." }, 403);
  let email: unknown;
  try { email = ((await req.json()) as { email?: unknown }).email; } catch { return json({ error: "Invalid JSON." }, 400); }
  const r = await requestLink(makeSupabaseTeamStore(), email);
  return json({ message: r.message }, r.status);
}
