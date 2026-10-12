import { guarded, json } from "@/lib/api-guard";
import { editTerm, removeTerm } from "@/lib/watch-service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guarded(req, "owner", async (s, team, body) => { const r = await editTerm(team, s, id, body); return r.ok ? json(r) : json(r, r.status); });
}
export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guarded(req, "owner", async (s, team) => { const r = await removeTerm(team, s, id); return r.ok ? json(r) : json(r, r.status); }, { body: false });
}
