import { guarded, json } from "@/lib/api-guard";
import { buildCurrentPack } from "@/lib/pack-service";

export const dynamic = "force-dynamic";

/** Owner-only: build or refresh the Monday pack from the latest saved report and the current decisions. */
export async function POST(req: Request) {
  return guarded(req, "owner", async (s, team) => json({ ok: true, ...(await buildCurrentPack(team, s.email)) }, 201), { body: false });
}
