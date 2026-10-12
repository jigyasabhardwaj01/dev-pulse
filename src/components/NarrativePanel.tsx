import { Icon } from "./Icons";

/** The saved weekly narrative, exactly as stored. Nothing here regenerates it. */
export default function NarrativePanel({ text, usedFallback, version }: { text: string; usedFallback: boolean; version: number | null }) {
  return (
    <section className="card summary" aria-labelledby="sum-heading">
      <h2 id="sum-heading" className="label"><Icon name="spark" size={15} />{usedFallback ? "Weekly summary (template)" : "AI weekly summary"}</h2>
      <p className="text">{text}</p>
      <p className="src-note">{usedFallback ? "Written from a template; the AI summary was unavailable." : "Written by Gemini Flash (via OpenRouter) from this week's counts."} Saved with report version {version ?? 1}.</p>
    </section>
  );
}
