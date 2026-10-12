import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/EmptyState";
import { SOURCE_LABEL } from "@/lib/coverage";
import { getPostsFor, getReport, type PostFilters } from "@/lib/data";
import { groupPainPoints } from "@/lib/grouping";
import { evidenceHref, overviewHref, reportHref } from "@/lib/insights";
import { requireKnownWeek } from "@/lib/page-guard";
import { truncate } from "@/lib/text";

export const metadata: Metadata = { title: "Evidence Explorer" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = Object.keys(SOURCE_LABEL);
const SENTIMENTS = ["negative", "neutral", "positive"];
const PAGE_SIZE = 20;
/** getPostsFor loads at most this many posts per pain point and week. */
const LOAD_CAP = 300;

type Q = Record<string, string | undefined>;
const href = (base: Q, change: Q) => {
  const merged = { ...base, ...change };
  const qs = Object.entries(merged).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  return `/posts?${qs}`;
};

/** Chooser shown when no pain point is selected: every pain point of one week, each linking to its evidence. */
async function Picker({ week }: { week?: string }): Promise<React.ReactElement> {
  let report = null;
  try { report = await getReport(week); } catch { return <EmptyState title="We couldn't load the pain points" body="The database didn't answer. Nothing was changed. Try again in a moment." action={{ href: "/posts", label: "Try again" }} />; }
  if (!report) return <EmptyState title="No reports yet" body="Evidence appears once a weekly report exists." action={{ href: "/status", label: "Check pipeline health" }} />;
  const groups = groupPainPoints(report.points);
  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Evidence Explorer</p>
        <h1>Find the posts behind a finding</h1>
        <p className="lede">Choose a pain point to read the posts that were counted for it in {report.periodLabel}.</p>
        <div className="pager"><Link className="btn" href={overviewHref(report.weekStart)}>Back to the overview</Link><Link className="btn" href={reportHref(report.weekStart)}>Open the full report</Link></div>
      </header>
      {groups.map((g) => (
        <section key={g.topic_id} className="section" aria-label={g.category}>
          <div className="section-head"><h2>{g.category}</h2><p>{g.totalMentions} {g.totalMentions === 1 ? "mention" : "mentions"}</p></div>
          <div className="pick-grid">
            {g.items.filter((i) => i.count > 0).map((i) => (
              <Link key={i.theme} className="card pick" href={evidenceHref(i, report.weekStart)}>
                <span style={{ fontWeight: 600 }}>{i.theme}<span className="sr-only">: view posts</span></span>
                <span className="num muted small">{i.count} {i.count === 1 ? "post" : "posts"} →</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export default async function Posts({ searchParams }: { searchParams: Promise<Q> }) {
  const q = await searchParams;
  const { topic, theme, week } = q;
  await requireKnownWeek(week);
  if (!topic || !UUID.test(topic) || !theme || !week) return Picker({ week });

  const filters: PostFilters = {
    source: q.source && SOURCES.includes(q.source) ? q.source : undefined,
    sentiment: q.sentiment && SENTIMENTS.includes(q.sentiment) ? q.sentiment : undefined,
    unresolvedOnly: q.unresolved === "1",
  };
  const search = (q.q ?? "").trim().slice(0, 100);
  let data = null;
  try { data = await getPostsFor(topic, theme, week, filters); } catch { /* handled below */ }
  if (!data) return <EmptyState title="We couldn't load these posts" body="The database didn't answer. Nothing was changed. Try again in a moment." action={{ href: href({ topic, theme, week }, {}), label: "Try again" }} />;

  const needle = search.toLowerCase();
  const matching = needle ? data.posts.filter((p) => `${p.title} ${p.body}`.toLowerCase().includes(needle)) : data.posts;
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(q.page ?? "1", 10) || 1));
  const shown = matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const base: Q = { topic, theme, week, source: filters.source, sentiment: filters.sentiment, unresolved: filters.unresolvedOnly ? "1" : undefined, q: search || undefined };
  const filtered = Boolean(filters.source || filters.sentiment || filters.unresolvedOnly || search);
  const capped = data.total >= LOAD_CAP;

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Evidence Explorer</p>
        <h1>{theme}</h1>
        <div className="chips-row">
          <span className="pill accent">{data.periodLabel}</span>
          <span className="muted small">{data.topicName}</span>
          <span className="muted small num" role="status">
            {filtered ? `${matching.length} of ${data.total} ${data.total === 1 ? "post" : "posts"} match` : `${data.total} ${data.total === 1 ? "post" : "posts"}`}
          </span>
        </div>
        <div className="pager">
          <Link className="btn" href={overviewHref(week)}><span aria-hidden="true">←</span> Back to the overview</Link>
          <Link className="btn" href={`/posts?week=${week}`}>Choose another pain point</Link>
        </div>
      </header>

      {capped && <div className="alert info" role="note"><p><strong>Capped. </strong>Only the newest {LOAD_CAP} posts for this pain point are loaded, so there may be more than shown, and filters and search apply to these {LOAD_CAP}.</p></div>}

      <section className="card toolbar" aria-label="Filter and search posts">
        <div className="row">
          <label className="t" htmlFor="q">Search</label>
          <form className="search" action="/posts" method="get" role="search">
            {Object.entries({ topic, theme, week, source: filters.source, sentiment: filters.sentiment, unresolved: filters.unresolvedOnly ? "1" : undefined }).filter(([, v]) => v).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <input id="q" name="q" type="search" defaultValue={search} placeholder={`Search the ${data.total} loaded posts`} maxLength={100} />
            <button className="btn" type="submit">Search</button>
          </form>
        </div>
        <div className="row">
          <span className="t" id="f-src">Source</span>
          <Link className="btn" href={href(base, { source: undefined, page: undefined })} aria-current={!filters.source ? "true" : undefined}>All ({data.total})</Link>
          {SOURCES.filter((s) => data.bySource[s]).map((s) => (
            <Link key={s} className="btn" href={href(base, { source: s, page: undefined })} aria-current={filters.source === s ? "true" : undefined}>{SOURCE_LABEL[s]} ({data.bySource[s]})</Link>
          ))}
        </div>
        <div className="row">
          <span className="t" id="f-show">Show</span>
          <Link className="btn" href={href(base, { unresolved: filters.unresolvedOnly ? undefined : "1", page: undefined })} aria-current={filters.unresolvedOnly ? "true" : undefined}>Unresolved only</Link>
          {SENTIMENTS.map((s) => (
            <Link key={s} className="btn" href={href(base, { sentiment: filters.sentiment === s ? undefined : s, page: undefined })} aria-current={filters.sentiment === s ? "true" : undefined}>{s[0].toUpperCase() + s.slice(1)}</Link>
          ))}
          {filtered && <Link className="btn" href={href({ topic, theme, week }, {})}>Clear all</Link>}
        </div>
        <p className="faint small">Evidence is limited to this reporting period. Search matches post titles and text.</p>
      </section>

      {shown.length === 0 ? (
        <EmptyState
          title={data.total === 0 ? "No stored posts for this selection" : "No posts match these filters"}
          body={data.total === 0 ? "The count on the report may come from posts that were later removed." : "Try removing a filter or searching for something shorter."}
          action={filtered ? { href: href({ topic, theme, week }, {}), label: "Clear filters" } : undefined}
        />
      ) : (
        <>
          <ul className="posts">
            {shown.map((p) => (
              <li key={p.id} className="card post">
                <div className="post-head">
                  <span className="src-tag">{SOURCE_LABEL[p.source] ?? p.source}</span>
                  <time dateTime={p.posted_at}>{new Date(p.posted_at).toISOString().slice(0, 10)}</time>
                  {p.author && <span>{p.author}</span>}
                  {p.unresolved && <span className="pill warn">Unresolved</span>}
                  {p.sentiment && <span className="pill neutral">{p.sentiment}</span>}
                  <span className="pill accent">{theme}</span>
                </div>
                <div className="post-title">
                  {p.url ? <a href={p.url} target="_blank" rel="noopener noreferrer">{p.title || "(comment)"}<span className="sr-only"> (opens the original post in a new tab)</span></a> : p.title || "(comment)"}
                </div>
                {p.body && <p className="snippet">{truncate(p.body, 360)}</p>}
              </li>
            ))}
          </ul>
          <nav className="pager-row" aria-label="Pages of results">
            <span className="muted small num">Showing {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + shown.length} of {matching.length}{capped ? " loaded" : ""}</span>
            {pages > 1 && (
              <span className="pager">
                <Link className="btn" href={href(base, { page: page > 2 ? String(page - 1) : undefined })} aria-disabled={page <= 1} tabIndex={page <= 1 ? -1 : undefined}>← Newer</Link>
                <span className="muted small" style={{ alignSelf: "center" }}>Page {page} of {pages}</span>
                <Link className="btn" href={href(base, { page: String(page + 1) })} aria-disabled={page >= pages} tabIndex={page >= pages ? -1 : undefined}>Older →</Link>
              </span>
            )}
          </nav>
        </>
      )}
    </>
  );
}
