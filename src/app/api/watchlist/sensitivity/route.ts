import { guarded, json } from "@/lib/api-guard";
import { setSensitivity } from "@/lib/watch-service";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  return guarded(req, "owner", async (s, team, body) => { const r = await setSensitivity(team, s, body.sensitivity); return r.ok ? json(r) : json(r, r.status); });
}
