/** The whole product in one line, set like an equation and scrolling on narrow screens. Plain text for screen readers. */
const PARTS = ["Hacker News", "+", "Stack Overflow", "+", "GitHub", "→", "Gemini", "→", "Evidence check", "=", "This week's signal"];
export default function Equation() {
  const row = PARTS.map((p, i) => <span key={i} className={p.length === 1 ? "op" : "term"}>{p}</span>);
  return (
    <div className="equation" role="img" aria-label="How JARVIS works: Hacker News, Stack Overflow and GitHub discussions are analysed by Gemini, checked against the original evidence, and become this week's signal.">
      <div className="equation-track" aria-hidden="true"><div className="equation-row">{row}</div><div className="equation-row dup">{row}</div></div>
    </div>
  );
}
