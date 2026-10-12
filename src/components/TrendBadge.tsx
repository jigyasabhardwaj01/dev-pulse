import { trendArrow, trendLabel, type PainItem } from "@/lib/grouping";

const EXPLAIN = "Not compared with the previous period: source coverage differs, so a rise or fall here would not be reliable.";

/** Direction is always conveyed by shape and words as well as colour. "unavailable" never looks like a real trend. */
export default function TrendBadge({ item }: { item: Pick<PainItem, "direction" | "pct" | "count" | "previous"> }) {
  const label = trendLabel(item);
  return (
    <span className={`trend ${item.direction}`} title={item.direction === "unavailable" ? EXPLAIN : undefined}>
      <span aria-hidden="true">{trendArrow(item.direction)}</span>
      <span>{label}</span>
    </span>
  );
}
