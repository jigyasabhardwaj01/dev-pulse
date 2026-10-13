/** A dashed "cut along line" divider with a pair of scissors travelling along it. Decorative. */
export default function CutLine({ label = "Cut along line" }: { label?: string }) {
  return (
    <div className="cutline" aria-hidden="true">
      <span className="cut-label mono">{label}</span>
      <span className="cut-track"><span className="scissors">✂</span></span>
      <span className="cut-arrows mono">▸▸▸</span>
    </div>
  );
}
