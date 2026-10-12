import { guarded, json } from "@/lib/api-guard";
import { castVote, withdrawVote } from "@/lib/team";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guarded(req, "member", async (s, team, body) => { const r = await castVote(team, s, id, body.choice); return r.ok ? json(r) : json(r, r.status); });
}
export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guarded(req, "member", async (s, team) => { const r = await withdrawVote(team, s, id); return r.ok ? json(r) : json(r, r.status); }, { body: false });
}
