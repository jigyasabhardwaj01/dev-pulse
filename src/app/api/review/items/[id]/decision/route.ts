import { guarded, json } from "@/lib/api-guard";
import { decide } from "@/lib/team";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return guarded(req, "owner", async (s, team, body) => { const r = await decide(team, s, id, body); return r.ok ? json(r, 201) : json(r, r.status); });
}
