import { guarded, json } from "@/lib/api-guard";
import { setItemState } from "@/lib/team";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return guarded(req, "owner", async (s, team, body) => { const r = await setItemState(team, s, id, body.state); return r.ok ? json(r) : json(r, r.status); });
}
