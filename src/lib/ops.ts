import type { Checkpoint } from "./checkpoints";
import { STALE_AFTER_DAYS, ago, label } from "./health";

/* Read models for the checkpoint and alert panels of Pipeline Health. Pure: the page passes in what the database returned. */
export type CheckpointState = "ok" | "attention" | "unknown";
export interface CheckpointRow {
  source: string; sourceName: string; topic: string; state: CheckpointState; headline: string; detail: string;
  lastAttemptAt: string | null; lastSuccessAt: string | null; committedThrough: string | null; coveredFrom: string | null; status: string | null;
}

/**
 * What a checkpoint says, in plain words. Attempt, success and committed are three different facts:
 *  - committed_through is the only one that means "everything before this was fetched completely and stored"
 *  - an attempt later than the last success means the latest try did NOT complete cleanly
 * Anything missing is "not recorded", never presented as healthy or as zero.
 */
export function readCheckpoint(cp: Checkpoint, topicName: string, now: Date): CheckpointRow {
  const base = { source: cp.source, sourceName: label(cp.source), topic: topicName, lastAttemptAt: cp.last_attempt_at, lastSuccessAt: cp.last_success_at, committedThrough: cp.committed_through, coveredFrom: cp.covered_from, status: cp.last_status };
  const att = cp.last_attempt_at ? new Date(cp.last_attempt_at).getTime() : null;
  const suc = cp.last_success_at ? new Date(cp.last_success_at).getTime() : null;
  if (att === null) return { ...base, state: "unknown", headline: "No attempt recorded", detail: "This source has not been tried for this topic since checkpoints were introduced." };
  const stale = now.getTime() - att > STALE_AFTER_DAYS * 86_400_000;
  if (cp.last_status === "error") return { ...base, state: "attention", headline: "Last attempt failed", detail: `Nothing was committed from it; the next run resumes from ${cp.committed_through ? "the committed point" : "the start of the period"} so no data is skipped.` };
  if (cp.last_status === "partial" || (suc !== null && att > suc)) return { ...base, state: "attention", headline: "Last attempt was incomplete", detail: "Some requests failed or the results were capped, so the committed point did not move. The next run covers the gap." };
  if (stale) return { ...base, state: "attention", headline: "Not attempted recently", detail: `Last attempt ${ago(cp.last_attempt_at, now)}.` };
  if (!cp.committed_through) return { ...base, state: "unknown", headline: "Attempted, nothing committed yet", detail: "A complete, uncapped fetch has not been stored yet, so no range is marked as covered." };
  return { ...base, state: "ok", headline: "Up to date", detail: `Everything before the committed point was fetched completely and stored.` };
}

export interface AlertRow { id: number; kind: string; key: string; status: string; at: string; runId: string | null }
export const ALERT_KIND: Record<string, string> = { run_failed: "Weekly run failed", email_failed: "Email could not be sent", email_unconfirmed: "Email delivery uncertain", sources_down: "Every source failed" };
export const alertKindLabel = (k: string) => ALERT_KIND[k] ?? k;
