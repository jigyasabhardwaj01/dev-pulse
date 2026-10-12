import { SOURCE_LABEL, type Coverage } from "@/lib/coverage";

const WORDS: Record<string, string> = { ok: "healthy", partial: "partly failed", error: "fetch failed" };

export default function SourceHealth({ sources }: { sources: Coverage | null | undefined }) {
  const entries = Object.entries(sources ?? {});
  if (!entries.length) return null;
  return (
    <section className="card sources" aria-labelledby="src-heading">
      <h2 id="src-heading">Where the data came from</h2>
      <ul className="chips">
        {entries.map(([s, v]) => (
          <li key={s} className={`chip ${v!.status}`}>
            <span className="dot" aria-hidden="true" />
            <span><strong>{SOURCE_LABEL[s] ?? s}</strong> <span className="muted">{WORDS[v!.status] ?? v!.status}</span></span>
            <span className="count">{v!.posts} {v!.posts === 1 ? "post" : "posts"}{v!.truncated ? " · capped" : ""}</span>
          </li>
        ))}
      </ul>
      <p className="muted small">
        Posts are everything collected from a source in the period, including posts that did not match a tracked theme, so this is larger than the mention counts below.
      </p>
    </section>
  );
}
