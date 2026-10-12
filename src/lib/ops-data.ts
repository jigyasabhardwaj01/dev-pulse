import { supabaseFromEnv } from "./store";
import type { Checkpoint } from "./checkpoints";
import type { AlertRow } from "./ops";

export type Section<T> = { ok: true; rows: T[] } | { ok: false };

/** Reads the checkpoint and alert tables. A failed read is reported as unavailable, never as an empty (healthy-looking) list. */
export async function loadOps(db = supabaseFromEnv()): Promise<{ checkpoints: Section<Checkpoint>; alerts: Section<AlertRow>; topics: Record<string, string> }> {
  const [cp, al, tp] = await Promise.all([
    db.from("source_checkpoints").select("source, topic_id, last_attempt_at, last_success_at, covered_from, committed_through, last_status").order("source").order("topic_id"),
    db.from("alert_log").select("id, kind, key, status, at, run_id").order("at", { ascending: false }).limit(10),
    db.from("topics").select("id, name"),
  ]);
  return {
    checkpoints: cp.error ? { ok: false } : { ok: true, rows: (cp.data ?? []) as Checkpoint[] },
    alerts: al.error ? { ok: false } : { ok: true, rows: ((al.data ?? []) as { id: number; kind: string; key: string; status: string; at: string; run_id: string | null }[]).map((a) => ({ id: a.id, kind: a.kind, key: a.key, status: a.status, at: a.at, runId: a.run_id })) },
    topics: Object.fromEntries(((tp.data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name])),
  };
}
