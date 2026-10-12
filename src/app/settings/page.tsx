import type { Metadata } from "next";
import Link from "next/link";
import { getRecentRuns } from "@/lib/data";
import { ago, scheduleText } from "@/lib/health";
import { readSchedule } from "@/lib/schedule";
import { redditAccessFrom } from "@/lib/sources/reddit-access";
import vercelConfig from "../../../vercel.json";

export const metadata: Metadata = { title: "Settings & Diagnostics" };
export const dynamic = "force-dynamic";

const LINKS = [
  { href: "/watchlist", t: "Watchlist", d: "The topics and search terms JARVIS looks for, and how strict it is." },
  { href: "/reports", t: "Past reports", d: "Every weekly report that was saved, including whether it was emailed." },
  { href: "/posts", t: "Stored discussions", d: "Browse the discussions behind any count." },
  { href: "/history", t: "History", d: "How problems moved from week to week." },
  { href: "/status", t: "Technical status", d: "Every run, source by source, with errors and alerts. For whoever maintains JARVIS." },
];

export default async function Settings() {
  const now = new Date();
  const runs = await getRecentRuns(1).catch(() => null);
  const run = runs?.[0] ?? null;
  const schedule = scheduleText(readSchedule(vercelConfig), now);
  const reddit = redditAccessFrom(process.env);
  const sources = [
    { id: "hn", name: "Hacker News" }, { id: "stackoverflow", name: "Stack Overflow" }, { id: "github", name: "GitHub Issues" },
  ].map((s) => {
    const r = run?.sources.find((x) => x.source === s.id);
    return { ...s, state: !run ? "Not checked yet" : !r ? "Not recorded in the last run" : r.status === "ok" ? "Answered fully" : r.status === "partial" ? "Answered in part" : "Did not answer" };
  });
  return (
    <>
      <header className="hero">
        <p className="eyebrow">Behind the scenes</p>
        <h1>Settings &amp; diagnostics</h1>
        <p className="lede">Most people never need this page. It shows where the data comes from and keeps the technical details out of the way.</p>
      </header>

      <section className="card card-pad stack" aria-labelledby="src-h">
        <h2 id="src-h">Where the discussions come from</h2>
        <table className="src-table">
          <thead><tr><th scope="col">Source</th><th scope="col">Last check</th></tr></thead>
          <tbody>
            {sources.map((s) => <tr key={s.id}><th scope="row">{s.name}</th><td>{s.state}{run ? ` · ${ago(run.finishedAt ?? run.startedAt, now)}` : ""}</td></tr>)}
            <tr><th scope="row">Reddit</th><td>{reddit.enabled ? "Switched on, but not yet confirmed working" : "Not collected"}{!reddit.enabled && <span className="muted small" style={{ display: "block" }}>{reddit.reason}.</span>}</td></tr>
          </tbody>
        </table>
        <p className="muted small">{schedule.label}. {schedule.detail}</p>
      </section>

      <section aria-label="More pages"><ul className="settings-grid" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {LINKS.map((l) => <li key={l.href}><Link className="card" href={l.href}><strong>{l.t}</strong><span>{l.d}</span></Link></li>)}
      </ul></section>
    </>
  );
}
