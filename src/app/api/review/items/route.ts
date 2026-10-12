import { guarded, json, savedPainPointLookup } from "@/lib/api-guard";
import { shortlist } from "@/lib/team";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return guarded(req, "member", async (s, team, body) => { const r = await shortlist(team, s, savedPainPointLookup, body); return r.ok ? json(r, r.created ? 201 : 200) : json(r, r.status); });
}
