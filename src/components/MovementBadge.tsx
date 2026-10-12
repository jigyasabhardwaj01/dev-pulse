import { movement } from "@/lib/insights";
import type { ThemeTrend } from "@/lib/types";

const ARROW = { up: "▲", down: "▼", new: "●", flat: "–", na: "·" } as const;

/** Direction is conveyed by shape and words as well as colour. A withheld trend never looks like a real one. */
export default function MovementBadge({ item, showCounts = false }: { item: Pick<ThemeTrend, "direction" | "count" | "previous" | "pct">; showCounts?: boolean }) {
  const m = movement(item);
  return (
    <span style={{ display: "inline-grid", gap: 1 }}>
      <span className={`delta ${m.kind}`} title={m.sentence}>
        <span aria-hidden="true">{ARROW[m.kind]}</span>
        <span>{m.label}</span>
        <span className="sr-only">. {m.sentence}</span>
      </span>
      {showCounts && m.counts && <span className="faint num" style={{ fontSize: ".72rem" }} aria-hidden="true">{m.counts}</span>}
    </span>
  );
}
