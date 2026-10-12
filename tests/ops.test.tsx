import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import OpsPanels from "@/components/OpsPanels";
import { alertKindLabel, readCheckpoint } from "@/lib/ops";
import { loadOps } from "@/lib/ops-data";
import type { Checkpoint } from "@/lib/checkpoints";

const NOW = new Date("2026-10-16T05:00:00Z");
const cp = (o: Partial<Checkpoint> = {}): Checkpoint => ({ source: "hn", topic_id: "t1", last_attempt_at: "2026-10-16T00:31:00Z", last_success_at: "2026-10-16T00:31:00Z", covered_from: "2026-10-08T18:30:00Z", committed_through: "2026-10-15T18:30:00Z", last_status: "ok", ...o });

describe("checkpoint reading", () => {
  it("a clean, committed checkpoint is up to date", () => expect(readCheckpoint(cp(), "Code review", NOW)).toMatchObject({ state: "ok", headline: "Up to date", sourceName: "Hacker News", topic: "Code review" }));
  it("never attempted is unknown, not healthy", () => expect(readCheckpoint(cp({ last_attempt_at: null, last_success_at: null, committed_through: null, last_status: null }), "T", NOW)).toMatchObject({ state: "unknown", headline: "No attempt recorded" }));
  it("a failed last attempt needs attention and says nothing was committed from it", () => {
    const r = readCheckpoint(cp({ last_status: "error", last_attempt_at: "2026-10-16T00:31:00Z", last_success_at: "2026-10-09T00:31:00Z" }), "T", NOW);
    expect(r).toMatchObject({ state: "attention", headline: "Last attempt failed" });
    expect(r.detail).toMatch(/Nothing was committed/);
  });
  it("partial, or an attempt later than the last success, is incomplete", () => {
    expect(readCheckpoint(cp({ last_status: "partial" }), "T", NOW).headline).toBe("Last attempt was incomplete");
    expect(readCheckpoint(cp({ last_status: "ok", last_attempt_at: "2026-10-16T01:00:00Z", last_success_at: "2026-10-09T01:00:00Z" }), "T", NOW).state).toBe("attention");
  });
  it("an old attempt is stale; attempted but nothing committed is unknown", () => {
    expect(readCheckpoint(cp({ last_attempt_at: "2026-09-01T00:00:00Z", last_success_at: "2026-09-01T00:00:00Z" }), "T", NOW).headline).toBe("Not attempted recently");
    expect(readCheckpoint(cp({ committed_through: null }), "T", NOW)).toMatchObject({ state: "unknown", headline: "Attempted, nothing committed yet" });
  });
  it("unknown alert kinds are shown as written", () => { expect(alertKindLabel("run_failed")).toBe("Weekly run failed"); expect(alertKindLabel("odd")).toBe("odd"); });
});

const html = (p: Parameters<typeof OpsPanels>[0]) => renderToStaticMarkup(<OpsPanels {...p} />);
describe("Pipeline Health: checkpoint and alert panels", () => {
  it("empty tables say 'not recorded yet', never zero or healthy", () => {
    const out = html({ checkpoints: { ok: true, rows: [] }, alerts: { ok: true, rows: [] }, topics: {}, now: NOW });
    expect(out).toContain("No checkpoints recorded yet"); expect(out).toContain("No alert records"); expect(out).toContain("not proof that nothing failed");
    expect(out).not.toContain("Up to date");
  });
  it("unreadable tables are 'unknown', not empty", () => {
    const out = html({ checkpoints: { ok: false }, alerts: { ok: false }, topics: {}, now: NOW });
    expect(out).toContain("Checkpoint records could not be read"); expect(out).toContain("Alert records could not be read"); expect(out).toContain("not assumed healthy");
    expect(out).not.toContain("No checkpoints recorded");
  });
  it("shows each checkpoint with its three separate facts and a labelled table", () => {
    const out = html({ checkpoints: { ok: true, rows: [cp(), cp({ source: "reddit", last_status: "error" })] }, alerts: { ok: true, rows: [] }, topics: { t1: "Code review" }, now: NOW });
    expect(out).toContain("Collection checkpoints by source and topic"); expect(out).toContain('scope="col"');
    expect(out).toContain("Hacker News"); expect(out).toContain("Reddit"); expect(out).toContain("Up to date"); expect(out).toContain("Last attempt failed");
    expect(out).toContain("Committed through"); expect(out).toContain("Code review");
  });
  it("lists alerts with sanitised, labelled facts and the 'submitted, not delivered' caveat; escapes text", () => {
    const out = html({ checkpoints: { ok: true, rows: [] }, alerts: { ok: true, rows: [{ id: 1, kind: "email_failed", key: "email_failed:2026-10-09", status: "sent", at: "2026-10-16T01:00:00Z", runId: null }, { id: 2, kind: "<b>x</b>", key: "<i>k</i>", status: "failed", at: "2026-10-16T02:00:00Z", runId: null }] }, topics: {}, now: NOW });
    expect(out).toContain("Email could not be sent"); expect(out).toContain("report week 2026-10-09"); expect(out).toContain("Attempted"); expect(out).toContain("does not confirm inbox delivery");
    expect(out).not.toContain("<b>x</b>"); expect(out).not.toContain("<i>k</i>");
  });
  it("loadOps reports a failed read as unavailable and keeps the other section", async () => {
    const mk = (fail: string) => ({ from: (t: string) => { const q: Record<string, unknown> = {}; const p = new Proxy(q, { get: (_x, k: string) => (k === "then" ? (r: (v: unknown) => unknown) => r(t === fail ? { data: null, error: { message: "x" } } : { data: [], error: null }) : () => p) }); return p; } });
    const r = await loadOps(mk("source_checkpoints") as never);
    expect(r.checkpoints).toEqual({ ok: false }); expect(r.alerts).toEqual({ ok: true, rows: [] });
  });
});
