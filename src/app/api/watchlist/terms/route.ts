import { guarded, json } from "@/lib/api-guard";
import { makeSupabaseStore } from "@/lib/store";
import { addTerm } from "@/lib/watch-service";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return guarded(req, "owner", async (s, team, body) => {
    const topics = (await makeSupabaseStore().getActiveTopics()).map((t) => t.id);
    const r = await addTerm(team, s, topics, body);
    return r.ok ? json(r, 201) : json(r, r.status);
  });
}
