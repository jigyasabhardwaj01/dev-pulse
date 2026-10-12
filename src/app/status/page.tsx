import type { Metadata } from "next";
import AttentionList from "@/components/AttentionList";
import EmptyState from "@/components/EmptyState";
import HealthSummary from "@/components/HealthSummary";
import LatestRun from "@/components/LatestRun";
import OpsPanels from "@/components/OpsPanels";
import RunHistory from "@/components/RunHistory";
import { loadOps } from "@/lib/ops-data";
import { getRecentRuns } from "@/lib/data";
import { assessHealth, attentionItems, formatReadTime } from "@/lib/health";
import { readSchedule } from "@/lib/schedule";
import vercelConfig from "../../../vercel.json";

export const metadata: Metadata = { title: "Pipeline Health" };
export const dynamic = "force-dynamic";

/** Read-only health view. Nothing here can start, stop or change a run, and no raw error text reaches the page. */
export default async function Status() {
  const now = new Date();
  let runs = null;
  let failed = false;
  try { runs = await getRecentRuns(10); } catch { failed = true; }
  if (failed) return <EmptyState title="We couldn't load run history" body="The database didn't answer, so the health below can't be checked right now. Nothing was changed. Reload in a moment." action={{ href: "/status", label: "Reload" }} />;
  if (runs === null) return <EmptyState title="Run history isn't available yet" body="It starts recording once the reliability update has been applied to the database." />;
  if (!runs.length) return <EmptyState title="No runs recorded yet" body="Each scheduled or backfill run appears here with the health of every source. Until then, health is unknown." />;

  const ops = await loadOps().catch(() => ({ checkpoints: { ok: false as const }, alerts: { ok: false as const }, topics: {} }));
  const schedule = readSchedule(vercelConfig);
  const health = assessHealth({ runs, schedule, now });
  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Operations · read-only</p>
        <h1>Pipeline Health</h1>
        <p className="lede">Is the pipeline working, what did it collect, and does anything need a person? Every status below comes from recorded runs; a failed source is a gap, never &ldquo;zero posts&rdquo;.</p>
        <div className="chips-row">
          <span className="muted small" role="status">Read from the database {formatReadTime(now)}</span>
          <a className="btn" href="/status">Reload</a>
        </div>
      </header>
      <HealthSummary health={health} schedule={schedule} now={now} />
      <AttentionList items={attentionItems(health)} />
      <LatestRun health={health} now={now} />
      <RunHistory runs={runs} />
      <OpsPanels {...ops} now={now} />
    </>
  );
}
