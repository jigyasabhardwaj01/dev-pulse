import type { Metadata } from "next";
import EmptyState from "@/components/EmptyState";
import { AddTermForm, SensitivityForm, TermActions } from "@/components/WatchlistControls";
import { currentSession } from "@/lib/session";
import { loadWatchlist, PRODUCTIVITY_DAYS, type TermView } from "@/lib/team-data";
import { ambiguityOf, classificationPolicy, SENSITIVITIES } from "@/lib/watchlist";
import { formatDateTime } from "@/lib/view";

export const metadata: Metadata = { title: "Watchlist" };
export const dynamic = "force-dynamic";

const MODE_HELP: Record<string, string> = {
  strict: "Fewest, highest-confidence results. A post must mention a term in its title or match two terms, and the model must be sure. Best when noise is costly.",
  balanced: "The default. Any whole-word match is considered; the model keeps real developer problems. Matches on very common words are flagged and held to a higher bar.",
  early: "Casts wider: also plural forms and weak or emerging signals, shown as “early signal”, never as established findings. More noise; catches things sooner.",
};
const ACTIVITY: Record<string, { label: string; cls: string }> = {
  producing: { label: "Producing evidence", cls: "ok" }, low: { label: "Low yield", cls: "warn" }, none: { label: "No matches", cls: "neutral" }, paused: { label: "Paused", cls: "neutral" },
};

function Term({ t, canEdit, kind }: { t: TermView; canEdit: boolean; kind: "include" | "exclude" }) {
  const a = ACTIVITY[t.activity];
  const amb = kind === "include" ? ambiguityOf(t.term) : null;
  return (
    <li className="term-row">
      <span>
        <strong>{t.term}</strong>
        {t.scopeLabel && <span className="muted small"> · only for “{t.scopeLabel}”</span>}
        {amb && <span className="pill warn" style={{ marginLeft: 8 }} title={amb}>Ambiguous</span>}
      </span>
      <span className="row-wrap small">
        <span className={`pill ${a.cls}`}>{a.label}</span>
        <span className="muted num">{t.matches} {kind === "include" ? "matched" : "removed"} · {PRODUCTIVITY_DAYS}d</span>
      </span>
      {canEdit ? <TermActions id={t.id} term={t.term} status={t.status} /> : <span />}
    </li>
  );
}

export default async function Watchlist() {
  await currentSession();
  const canEdit = true; // no login: every visitor may edit
  let view;
  try { view = await loadWatchlist(); } catch { view = null; }
  if (!view) return <EmptyState title="We couldn't load the watchlist" body="The database didn't answer. Nothing was changed. Reload in a moment." action={{ href: "/watchlist", label: "Reload" }} />;
  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Configuration · open to everyone</p>
        <h1>Watchlist</h1>
        <p className="lede">What JARVIS searches for, what it deliberately ignores, and how strict it is. A change applies from the next run; reports already saved keep the configuration they were built with.</p>
        <div className="chips-row">
        </div>
      </header>

      <section className="section" aria-labelledby="mode-h">
        <h2 id="mode-h">Detection mode</h2>
        {canEdit ? (
          <SensitivityForm value={view.sensitivity} options={SENSITIVITIES.map((s) => ({ value: s, label: classificationPolicy(s).label, help: MODE_HELP[s] }))} />
        ) : (
          <div className="card card-pad"><strong>{classificationPolicy(view.sensitivity).label}</strong><p className="muted small" style={{ margin: "4px 0 0" }}>{MODE_HELP[view.sensitivity]}</p></div>
        )}
      </section>

      {view.topics.map((t) => (
        <section key={t.id} className="card card-pad section" aria-labelledby={`t-${t.id}`}>
          <h2 id={`t-${t.id}`}>{t.name}</h2>
          {t.legacy && <p className="muted small">No watchlist terms are stored for this topic yet, so its built-in keywords are used: {t.legacyKeywords.join(", ")}.</p>}
          <div>
            <h3 className="small muted" style={{ textTransform: "uppercase", letterSpacing: ".08em" }}>Watching for</h3>
            {t.includes.length ? <ul className="term-list">{t.includes.map((x) => <Term key={x.id} t={x} canEdit={canEdit} kind="include" />)}</ul> : <p className="muted small">None.</p>}
          </div>
          <div>
            <h3 className="small muted" style={{ textTransform: "uppercase", letterSpacing: ".08em" }}>Excluding</h3>
            {t.excludes.length ? <ul className="term-list">{t.excludes.map((x) => <Term key={x.id} t={x} canEdit={canEdit} kind="exclude" />)}</ul> : <p className="muted small">None.</p>}
          </div>
          {canEdit && <AddTermForm topicId={t.id} topicName={t.name} includes={t.includes.map((i) => ({ id: i.id, term: i.term }))} />}
        </section>
      ))}

      <section className="section" aria-labelledby="chg-h">
        <h2 id="chg-h">Change history</h2>
        {view.changes.length === 0 ? <p className="muted">No changes have been made through this page yet.</p> : (
          <ul className="history-list card card-pad">
            {view.changes.map((c) => (
              <li key={c.id}><span className="num muted">{formatDateTime(c.at)}</span> · <strong>{c.action}</strong> {c.subject}</li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
