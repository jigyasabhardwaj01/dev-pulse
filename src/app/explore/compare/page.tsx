import type { Metadata } from "next";
import PageArt from "@/components/motion/PageArt";
import Link from "next/link";
import EmptyState from "@/components/EmptyState";
import { analysisFor } from "@/lib/analysis-source";
import { problemHref, problemsFrom } from "@/lib/insights-view";
import { makeSupabaseStore } from "@/lib/store";
import { makeSupabaseTeamStore } from "@/lib/team-store";

export const metadata: Metadata = { title: "Compare problems" };
export const dynamic = "force-dynamic";

export default async function Compare({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const week = typeof sp.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : null;
  const keys = [sp.k].flat().filter((x): x is string => typeof x === "string").slice(0, 3);
  if (!week || keys.length < 2) return <EmptyState title="Pick at least two problems" body="Go back, tick two or three problems, and press the compare button." action={{ href: "/explore", label: "Back to the list" }} />;
  let analysis;
  try { analysis = await analysisFor(makeSupabaseStore(), makeSupabaseTeamStore(), week); } catch { analysis = null; }
  if (!analysis) return <EmptyState title="We couldn't load the problems" body="The database didn't answer. Nothing was changed." action={{ href: "/explore", label: "Back to the list" }} />;
  if (analysis.kind === "none") return <EmptyState title="Nothing to compare" body="This report has no problem analysis." action={{ href: "/explore", label: "Back to the list" }} />;
  const all = problemsFrom(analysis.analysis, week).all;
  const picked = keys.map((k) => all.find((p) => `${p.topicId}|${p.theme}` === k)).filter((p): p is NonNullable<typeof p> => Boolean(p));
  if (picked.length < 2) return <EmptyState title="Those problems are not in this report" body="Go back and choose from the list." action={{ href: "/explore", label: "Back to the list" }} />;
  const rows: [string, (p: (typeof picked)[number]) => string][] = [
    ["Area", (p) => p.category], ["Separate discussions", (p) => String(p.discussions)], ["Sites", (p) => p.sources.join(", ")],
    ["Look unresolved", (p) => String(p.unresolved)], ["Compared with last week", (p) => `${p.trend.label}. ${p.trend.detail}`],
    ["How sure are we", (p) => p.confidence.label], ["JARVIS suggestion", (p) => (p.rank ? `Ranked number ${p.rank}` : p.supported ? "Enough evidence to rank" : "Not ranked: early signal")],
  ];
  return (
    <>
      <p className="small"><Link href="/explore">← All problems</Link></p>
      <header className="hero">
        <PageArt shape="torus" /><h1>Compare problems</h1><p className="lede">Side by side, from the same report. These are JARVIS&rsquo;s numbers; the decision is yours.</p></header>
      <div className="card card-pad" style={{ overflowX: "auto" }}>
        <table className="cmp">
          <thead><tr><th scope="col"><span className="sr-only">Measure</span></th>{picked.map((p) => <th key={p.key} scope="col" style={{ width: "auto", textTransform: "none", letterSpacing: 0, fontSize: ".95rem", color: "var(--text)" }}><Link href={problemHref(p)}>{p.theme}</Link></th>)}</tr></thead>
          <tbody>{rows.map(([label, f]) => <tr key={label}><th scope="row">{label}</th>{picked.map((p) => <td key={p.key}>{f(p)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <div className="actions">{picked.map((p) => <Link key={p.key} className="btn" href={problemHref(p)}>Open &ldquo;{p.theme}&rdquo;</Link>)}</div>
    </>
  );
}
