/*
 * A small square with a generative, animated texture standing for one problem: puffy 3D, halftone, spectrum stripes, repeated type or
 * ASCII. Pure CSS, so twenty of them cost nothing. The variant is picked from the problem's name, so a problem keeps its look week to week.
 */
export const TILE_KINDS = ["puffy", "halftone", "spectrum", "repeat", "ascii"] as const;
export type TileKind = (typeof TILE_KINDS)[number];

export const tileKind = (seed: string): TileKind => {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TILE_KINDS[h % TILE_KINDS.length];
};

const ASCII = ["#*+=-:.", ".:-=+*#", "*#%@%#*", ":::::::", "+=-:-=+", "@%#*+=-"];

export default function ProblemTile({ label, kind, index = 0, active = false, size = "md" }: { label: string; kind?: TileKind; index?: number; active?: boolean; size?: "sm" | "md" }) {
  const k = kind ?? tileKind(label);
  const short = label.split(/\s+/).slice(0, 2).join(" ").toUpperCase();
  return (
    <span className={`tile tile-${k} tile-${size}${active ? " is-active" : ""}`} style={{ ["--n" as string]: index }} aria-hidden="true">
      {k === "puffy" && <span className="tile-glyph">{String(index + 1).padStart(2, "0")}</span>}
      {k === "halftone" && <span className="tile-dots" />}
      {k === "spectrum" && <span className="tile-word">{short}</span>}
      {k === "repeat" && <span className="tile-repeat">{Array.from({ length: 6 }, (_, i) => <span key={i}>{short}. {short}. </span>)}</span>}
      {k === "ascii" && <span className="tile-ascii">{Array.from({ length: 7 }, (_, i) => <span key={i}>{ASCII[(i + index) % ASCII.length].repeat(3)}</span>)}</span>}
    </span>
  );
}
