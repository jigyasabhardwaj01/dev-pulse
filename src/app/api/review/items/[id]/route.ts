import { guarded, json } from "@/lib/api-guard";
import { withdrawItem } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Unshortlist: withdraws the item (the row and its audit trail are kept). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return guarded(req, "member", async (s, team) => { const r = await withdrawItem(team, s, id); return r.ok ? json(r) : json(r, r.status); }, { body: false });
}
