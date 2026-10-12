"use client";

import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/** Okabe-Ito based palette: distinguishable for the common kinds of colour blindness. */
const COLORS = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#7A6BCF", "#6B7280"];

export interface ChartRow { week: string; label: string; state: string; [series: string]: string | number }

const STATE_NOTE: Record<string, string> = {
  comparable: "Comparable with the previous week",
  no_prior: "First week recorded in this format",
  incomparable: "Source coverage differed from the previous week: do not read a trend into this point",
  legacy: "Earlier-format week",
};

/** Weeks that cannot be fairly compared with the previous one are drawn hollow and say why on hover. */
export default function TrendChart({ series, rows }: { series: string[]; rows: ChartRow[] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (s: string) => setHidden((h) => { const n = new Set(h); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  const flagged = rows.some((r) => r.state === "incomparable" || r.state === "legacy");

  return (
    <div className="card chart-card">
      <div className="chart-actions" role="group" aria-label="Show or hide a pain point">
        {series.map((s, i) => (
          <button key={s} type="button" className="series-btn" aria-pressed={!hidden.has(s)} onClick={() => toggle(s)}>
            <i style={{ background: COLORS[i % COLORS.length] }} aria-hidden="true" />{s}
          </button>
        ))}
      </div>
      <div role="img" aria-label="Line chart of mentions per pain point for each reporting week. The same data is available as a table below." style={{ width: "100%", height: 340 }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 10, right: 16, bottom: 4, left: -8 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--border-strong)" }} tick={{ fill: "var(--muted)", fontSize: 12 }} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} width={40} />
            <Tooltip
              cursor={{ stroke: "var(--border-strong)" }}
              contentStyle={{ background: "var(--surface)", border: "1px solid var(--border-strong)", borderRadius: 8, color: "var(--text)" }}
              labelFormatter={(_l, payload) => {
                const row = payload?.[0]?.payload as ChartRow | undefined;
                return row ? `Week of ${row.week} · ${STATE_NOTE[row.state] ?? ""}` : "";
              }}
            />
            {series.map((s, i) =>
              hidden.has(s) ? null : (
                <Line
                  key={s}
                  type="monotone"
                  dataKey={s}
                  stroke={COLORS[i % COLORS.length]}
                  strokeWidth={2}
                  isAnimationActive={false}
                  dot={(p: { cx?: number; cy?: number; payload?: ChartRow; index?: number }) => {
                    const ok = p.payload?.state === "comparable" || p.payload?.state === "no_prior";
                    return (
                      <circle
                        key={`${s}-${p.index}`}
                        cx={p.cx}
                        cy={p.cy}
                        r={4}
                        fill={ok ? COLORS[i % COLORS.length] : "var(--surface)"}
                        stroke={COLORS[i % COLORS.length]}
                        strokeWidth={2}
                      />
                    );
                  }}
                />
              ),
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {flagged && <p className="muted small">Hollow points mark weeks whose source coverage differed from the week before, so changes into or out of them are not reliable trends.</p>}
    </div>
  );
}
