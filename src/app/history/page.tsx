import TrendChart from "@/components/TrendChart";
import { getHistory } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function History() {
  let data = null;
  try {
    data = await getHistory();
  } catch {
    /* render the empty state below */
  }
  return (
    <>
      <h1>Mentions per theme, by week</h1>
      <p className="sub">Top themes by total mentions. Each point is one 7-day window.</p>
      {data && data.rows.length > 0 ? (
        <TrendChart series={data.series} rows={data.rows} />
      ) : (
        <p className="empty">No weekly data yet. It appears after the first cron run.</p>
      )}
    </>
  );
}
