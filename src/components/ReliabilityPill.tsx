import type { TrendReliability } from "@/lib/report-model";

const MAP: Record<TrendReliability, { cls: string; text: string }> = {
  comparable: { cls: "ok", text: "Compared" },
  no_prior: { cls: "info", text: "First report" },
  incomparable: { cls: "warn", text: "Trends withheld" },
  legacy: { cls: "neutral", text: "Earlier format" },
};

export default function ReliabilityPill({ value }: { value: TrendReliability }) {
  const m = MAP[value];
  return <span className={`pill ${m.cls}`}>{m.text}</span>;
}
