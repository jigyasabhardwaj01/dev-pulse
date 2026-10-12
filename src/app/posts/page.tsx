import Link from "next/link";
import { getPostsFor } from "@/lib/data";
import { truncate } from "@/lib/text";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_LABEL: Record<string, string> = { hn: "Hacker News", stackoverflow: "Stack Overflow", reddit: "Reddit", github: "GitHub" };

export default async function Posts({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { topic, theme, week } = await searchParams;
  if (!topic || !UUID.test(topic) || !theme || !week || !DATE.test(week)) {
    return <><h1>Posts</h1><p className="empty">Pick a pain point on the <Link href="/">dashboard</Link> to see its posts.</p></>;
  }
  let data = null;
  try {
    data = await getPostsFor(topic, theme, week);
  } catch {
    /* handled below */
  }
  if (!data) return <><h1>Posts</h1><p className="empty">Could not load posts right now.</p></>;

  return (
    <>
      <p className="sub"><Link href="/">← Back to dashboard</Link></p>
      <h1>{theme}</h1>
      <p className="sub">{data.topicName} · week of {week} · {data.posts.length} post{data.posts.length === 1 ? "" : "s"}</p>
      {data.posts.length === 0 && <p className="empty">No stored posts for this selection.</p>}
      <ul className="posts">
        {data.posts.map((p) => (
          <li key={p.id}>
            <div className="post-head">
              <span className="src">{SOURCE_LABEL[p.source] ?? p.source}</span>
              <span className="meta">{new Date(p.posted_at).toISOString().slice(0, 10)}{p.author ? ` · ${p.author}` : ""}</span>
              {p.unresolved && <span className="badge">unresolved</span>}
            </div>
            <div>{p.url ? <a href={p.url} target="_blank" rel="noopener noreferrer">{p.title || "(comment)"}</a> : (p.title || "(comment)")}</div>
            {p.body && <p className="snippet">{truncate(p.body, 320)}</p>}
          </li>
        ))}
      </ul>
    </>
  );
}
