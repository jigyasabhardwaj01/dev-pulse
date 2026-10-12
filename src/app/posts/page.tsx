import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/EmptyState";
import { SOURCE_LABEL } from "@/lib/coverage";
import { getPostsFor, type PostFilters } from "@/lib/data";
import { truncate } from "@/lib/text";

export const metadata: Metadata = { title: "Evidence" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = Object.keys(SOURCE_LABEL);
const SENTIMENTS = ["negative", "neutral", "positive"];

type Q = Record<string, string | undefined>;
const href = (base: Q, change: Q) => {
  const merged = { ...base, ...change };
  const qs = Object.entries(merged).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  return `/posts?${qs}`;
};

export default async function Posts({ searchParams }: { searchParams: Promise<Q> }) {
  const q = await searchParams;
  const { topic, theme, week } = q;
  if (!topic || !UUID.test(topic) || !theme || !week || !DATE.test(week)) {
    return <EmptyState title="Pick a pain point first" body="Evidence is shown for one pain point in one week. Open a report and choose “View posts”." action={{ href: "/", label: "Go to this week's report" }} />;
  }
  const filters: PostFilters = {
    source: q.source && SOURCES.includes(q.source) ? q.source : undefined,
    sentiment: q.sentiment && SENTIMENTS.includes(q.sentiment) ? q.sentiment : undefined,
    unresolvedOnly: q.unresolved === "1",
  };
  let data = null;
  try { data = await getPostsFor(topic, theme, week, filters); } catch { /* handled below */ }
  if (!data) return <EmptyState title="We couldn't load these posts" body="The database didn't answer. Try again in a moment." />;

  const base: Q = { topic, theme, week, source: filters.source, sentiment: filters.sentiment, unresolved: filters.unresolvedOnly ? "1" : undefined };
  const filtered = Boolean(filters.source || filters.sentiment || filters.unresolvedOnly);

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Evidence</p>
        <h1>{theme}</h1>
        <p className="muted">
          {data.topicName} · {data.periodLabel} ·{" "}
          {filtered ? `${data.posts.length} of ${data.total}` : data.total} {data.total === 1 ? "post" : "posts"}
        </p>
        <div className="pager"><Link className="btn" href={`/?week=${week}`}><span aria-hidden="true">←</span> Back to the report</Link></div>
      </header>

      <section className="filters" aria-label="Filter posts">
        <span className="muted small">Source</span>
        <Link className="btn" href={href(base, { source: undefined })} aria-current={!filters.source ? "true" : undefined}>All ({data.total})</Link>
        {SOURCES.filter((s) => data.bySource[s]).map((s) => (
          <Link key={s} className="btn" href={href(base, { source: s })} aria-current={filters.source === s ? "true" : undefined}>{SOURCE_LABEL[s]} ({data.bySource[s]})</Link>
        ))}
        <span className="muted small" style={{ marginLeft: 8 }}>Show</span>
        <Link className="btn" href={href(base, { unresolved: filters.unresolvedOnly ? undefined : "1" })} aria-current={filters.unresolvedOnly ? "true" : undefined}>Unresolved only</Link>
        {SENTIMENTS.map((s) => (
          <Link key={s} className="btn" href={href(base, { sentiment: filters.sentiment === s ? undefined : s })} aria-current={filters.sentiment === s ? "true" : undefined}>{s[0].toUpperCase() + s.slice(1)}</Link>
        ))}
      </section>

      {data.posts.length === 0 ? (
        <EmptyState title={data.total === 0 ? "No stored posts for this selection" : "No posts match these filters"} body={data.total === 0 ? "The count may come from posts that were later removed." : "Try removing a filter."} action={filtered ? { href: href({ topic, theme, week }, {}), label: "Clear filters" } : undefined} />
      ) : (
        <ul className="posts">
          {data.posts.map((p) => (
            <li key={p.id} className="card post">
              <div className="post-head">
                <span className="src">{SOURCE_LABEL[p.source] ?? p.source}</span>
                <time dateTime={p.posted_at}>{new Date(p.posted_at).toISOString().slice(0, 10)}</time>
                {p.author && <span>{p.author}</span>}
                {p.unresolved && <span className="pill warn">Unresolved</span>}
                {p.sentiment && <span className="pill neutral">{p.sentiment}</span>}
              </div>
              <div className="post-title">
                {p.url ? <a href={p.url} target="_blank" rel="noopener noreferrer">{p.title || "(comment)"}<span className="sr-only"> (opens in a new tab)</span></a> : p.title || "(comment)"}
              </div>
              {p.body && <p className="snippet">{truncate(p.body, 360)}</p>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
