import type { HistoryRow } from "@/lib/report-model";

const STATE: Record<string, string> = { comparable: "Comparable", no_prior: "First week", incomparable: "Coverage differed", legacy: "Earlier format" };

/** The chart's data as a table, for screen readers and for anyone who wants the numbers. */
export default function ChartTable({ series, rows }: { series: string[]; rows: HistoryRow[] }) {
  return (
    <details className="card data-table" style={{ padding: "12px 18px" }}>
      <summary>View the chart data as a table</summary>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table>
          <caption>Mentions per pain point, by reporting week</caption>
          <thead>
            <tr><th scope="col">Week of</th>{series.map((s) => <th key={s} scope="col" className="n">{s}</th>)}<th scope="col">Data quality</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.week}>
                <th scope="row">{r.week}</th>
                {series.map((s) => <td key={s} className="n">{r[s]}</td>)}
                <td>{STATE[r.state] ?? r.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
