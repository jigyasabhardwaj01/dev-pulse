"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface VolumeRow { week: string; label: string; mentions: number; state: string }

const NOTE: Record<string, string> = {
  comparable: "Comparable with the previous week",
  no_prior: "First week recorded in this format",
  incomparable: "Source coverage differed from the previous week",
};

/** Mentions matched to a tracked theme per reporting week. The highlighted bar is the selected week; hatched-looking (outlined) bars had different coverage. */
export default function VolumeChart({ rows, highlight }: { rows: VolumeRow[]; highlight?: string }) {
  const hi = highlight ?? rows[rows.length - 1]?.week;
  return (
    <div role="img" aria-label={`Bar chart of weekly mentions: ${rows.map((r) => `${r.label} ${r.mentions}`).join(", ")}.`} style={{ width: "100%", height: 230 }}>
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 12, right: 8, bottom: 0, left: -18 }} barCategoryGap="28%">
          <defs>
            <linearGradient id="vol-hi" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#E567D7" /><stop offset="100%" stopColor="#9C2266" /></linearGradient>
            <linearGradient id="vol-lo" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6b4a7d" /><stop offset="100%" stopColor="#3b2548" /></linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--border-strong)" }} tick={{ fill: "var(--muted)", fontSize: 11 }} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} width={44} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)", opacity: 0.6 }}
            content={({ active, payload }) => {
              const r = active ? (payload?.[0]?.payload as VolumeRow | undefined) : undefined;
              return r ? <div className="chart-tip"><strong>Week of {r.week}</strong><div className="num">{r.mentions} mentions</div><div className="muted">{NOTE[r.state] ?? ""}</div></div> : null;
            }}
          />
          <Bar dataKey="mentions" radius={[7, 7, 3, 3]} isAnimationActive={false}>
            {rows.map((r) => (
              <Cell
                key={r.week}
                fill={r.week === hi ? "url(#vol-hi)" : "url(#vol-lo)"}
                stroke={r.state === "incomparable" ? "var(--warn)" : "none"}
                strokeDasharray={r.state === "incomparable" ? "4 3" : undefined}
                style={r.week === hi ? { filter: "drop-shadow(0 0 10px rgba(229,103,215,.55))" } : undefined}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
