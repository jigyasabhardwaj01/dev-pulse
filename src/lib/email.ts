import type { FetchLike, ThemeTrend } from "./types";
import { comparisonCaveats, comparisonNote, type Comparison, type Coverage } from "./coverage";
import { formatPeriod } from "./view";
import { groupPainPoints, mentionsLine, trendArrow, trendLabel } from "./grouping";
import type { BriefItem, FridayBrief } from "./friday-brief";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const dashboardUrl = (env: NodeJS.ProcessEnv = process.env) =>
  (env.APP_URL || "").replace(/\/+$/, "") || null;

/** Headline + context line + grouped list + dashboard link. Same grouping as the dashboard. */
export const EMAIL_MAX_ITEMS = 10;

export function renderBriefHtml(weekStart: string, narrative: string, allPoints: ThemeTrend[], appUrl: string | null, comparison: Comparison | null = null): string {
  // Keep the email short: the top items by mentions; the dashboard has the rest.
  const sorted = [...allPoints].sort((a, b) => b.count - a.count);
  const points = sorted.slice(0, EMAIL_MAX_ITEMS);
  const hidden = sorted.length - points.length;
  const groups = groupPainPoints(points);
  const body = groups
    .map((g) => {
      const items = g.items
        .map((i) => {
          const flag = i.mostlyUnresolved ? ` <span style="color:#b54708;font-weight:600">⚑ mostly unresolved</span>` : "";
          return `<li style="margin:6px 0"><strong>${esc(i.theme)}</strong><br><span style="color:#555">${esc(mentionsLine(i))} · ${trendArrow(i.direction)} ${esc(trendLabel(i))}</span>${flag}</li>`;
        })
        .join("");
      return `<h3 style="margin:18px 0 4px">${esc(g.category)}</h3><ul style="margin:0;padding-left:18px">${items}</ul>`;
    })
    .join("");
  const more = hidden > 0 ? `<p style="color:#555;margin:14px 0 0">+ ${hidden} more pain point${hidden === 1 ? "" : "s"} on the dashboard.</p>` : "";
  const qualification = comparisonNote(comparison);
  const caveats = comparisonCaveats(comparison);
  const note =
    (qualification ? `<p style="margin:6px 0 0;color:#b54708;font-size:.92em">Data note: ${esc(qualification)}</p>` : "") +
    (caveats.length ? `<p style="margin:6px 0 0;color:#6b6b63;font-size:.88em">Caveats: ${esc(caveats.join("; "))}.</p>` : "");
  const link = appUrl ? `<p style="margin-top:20px"><a href="${esc(appUrl)}">View the full dashboard and underlying posts →</a></p>` : "";
  return `<div style="font-family:system-ui,sans-serif;max-width:620px;line-height:1.5">
<h2 style="margin:0 0 4px">JARVIS · week of ${esc(weekStart)}</h2>
${formatPeriod(weekStart) ? `<div style="color:#555;margin-bottom:2px">${esc(formatPeriod(weekStart))}</div>` : ""}
<div style="color:#555;margin-bottom:10px">${allPoints.reduce((s, p) => s + p.count, 0)} mentions matched to tracked themes across ${allPoints.filter((p) => p.count > 0).length} pain points</div>
<p style="margin:0 0 6px">${esc(narrative)}</p>${note}${body}${more}${link}</div>`;
}

/** Only plain http(s) links are ever rendered as links; anything else (javascript:, data:, relative) is shown as text. */
export const safeHref = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : null; } catch { return null; }
};

function itemHtml(i: BriefItem): string {
  const links = i.links.map((l) => {
    const href = safeHref(l.url);
    const label = esc(l.title || "discussion");
    return `<li style="margin:2px 0">${href ? `<a href="${esc(href)}">${label}</a>` : label} <span style="color:#6b6b63">(${esc(l.source)})</span></li>`;
  }).join("");
  return `<li style="margin:10px 0"><strong>${i.rank ? `${i.rank}. ` : ""}${esc(i.theme)}</strong> <span style="color:#6b6b63">· ${esc(i.category)}</span>${i.earlySignal ? ` <span style="color:#6b6b63">(early signal)</span>` : ""}<br>`
    + `<span style="color:#555">${esc(i.observed)}. ${esc(i.movement)}</span><br><span style="color:#555">${esc(i.resolution)}. Evidence: ${esc(i.evidenceStrength)}.</span>`
    + (i.because.length ? `<br><span style="color:#555">Ranked because: ${esc(i.because.join("; "))}</span>` : "")
    + (links ? `<ul style="margin:4px 0 0;padding-left:18px;font-size:.92em">${links}</ul>` : "")
    + `</li>`;
}

/** The Friday brief rendered from the SAVED structured brief. Observed facts, interpretation and suggestions are visibly separate. */
export function renderFridayHtml(brief: FridayBrief, appUrl: string | null): string {
  const o = brief.observed;
  const h = (t: string) => `<h3 style="margin:20px 0 4px">${esc(t)}</h3>`;
  const list = (items: BriefItem[]) => `<ul style="margin:0;padding-left:18px">${items.map(itemHtml).join("")}</ul>`;
  const section = (title: string, items: BriefItem[]) => (items.length ? h(title) + list(items) : "");
  const lines = (ls: string[]) => `<ul style="margin:0;padding-left:18px">${ls.map((l) => `<li style="margin:4px 0">${esc(l)}</li>`).join("")}</ul>`;
  const top = o.top.length ? list(o.top) : `<p style="margin:0;color:#555">No pain point has enough supporting evidence to be ranked this week.</p>`;
  const last = o.vsLastWeek.available ? lines(o.vsLastWeek.lines) : `<p style="margin:0;color:#555">Not shown: ${esc(o.vsLastWeek.withheldBecause ?? "no fair comparison with the previous period")}</p>`;
  const base = o.vsBaseline.available ? lines(o.vsBaseline.lines) : `<p style="margin:0;color:#555">Not available: ${esc(o.vsBaseline.unavailableBecause ?? "not enough comparable weeks")}</p>`;
  const sug = brief.suggestions.items.length
    ? `<ul style="margin:0;padding-left:18px">${brief.suggestions.items.map((s) => `<li style="margin:4px 0">${esc(s.text)}</li>`).join("")}</ul>` : "";
  const link = appUrl ? `<p style="margin-top:20px"><a href="${esc(appUrl)}/reports/${esc(brief.weekStart)}">View this report, with all evidence →</a></p>` : "";
  return `<div style="font-family:system-ui,sans-serif;max-width:620px;line-height:1.5">
<h2 style="margin:0 0 4px">JARVIS · week of ${esc(brief.weekStart)}</h2>
<div style="color:#555;margin-bottom:2px">${esc(brief.periodLabel)}</div>
<div style="color:#555;margin-bottom:10px">${o.totals.relevantDiscussions} relevant ${o.totals.relevantDiscussions === 1 ? "discussion" : "discussions"} matched across ${o.totals.painPoints} ${o.totals.painPoints === 1 ? "pain point" : "pain points"}</div>
${h("Summary")}<p style="margin:0">${esc(brief.interpretation.executiveSummary)}</p>
<p style="margin:4px 0 0;color:#6b6b63;font-size:.88em">Interpretation${brief.interpretation.usedTemplate ? " (template text, AI summary unavailable)" : " (AI-written from the data below)"}. ${esc(brief.interpretation.rankingNote)}</p>
${h("Top pain points (observed)")}${top}
${h("Compared with last week (observed)")}${last}
${h("Compared with the " + "recent baseline (observed)")}${base}
${section("New this week", o.emerging)}${section("Rising", o.rising)}${section("Declining", o.declining)}${section("Still unresolved", o.unresolved)}
${o.limitations.length ? h("Limitations") + lines(o.limitations) : ""}
${sug ? h(brief.suggestions.label) + sug : ""}
<p style="margin:18px 0 0;color:#6b6b63;font-size:.88em">${esc(brief.disclaimer)}</p>${link}</div>`;
}

/**
 * A send that threw. `definite` = the provider certainly did NOT accept the message (a 4xx rejection such as bad request or
 * rate limit). Everything else (network failure, timeout, 5xx, a 409 idempotency conflict) is ambiguous: the message may
 * have been accepted, so it must not be treated as "not sent" and must only be retried with the SAME idempotency key.
 */
export class EmailSendError extends Error {
  constructor(message: string, readonly definite: boolean) { super(message); this.name = "EmailSendError"; }
}
export const SEND_TIMEOUT_MS = 20_000;

/** Resend free tier. From onboarding@resend.dev, which can only deliver to the Resend account owner's address. */
export async function sendBriefEmail(
  args: { weekStart: string; version?: number; narrative: string; points: ThemeTrend[]; comparison?: Comparison | null; coverage?: Coverage; brief?: FridayBrief | null },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<"skipped" | { status: "sent"; messageId: string | null }> {
  const key = env.RESEND_API_KEY;
  const to = env.DIGEST_TO_EMAIL;
  if (!key || !to) return "skipped";
  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        // The key is scoped to the saved report VERSION, whose body is identical every time it is rendered. A crash-recovery
        // resend of the same version therefore carries the same key and body, which Resend (documented: 24 h) can
        // de-duplicate; a genuinely new version (after a failed send) gets a new key. Provider behaviour not verified live.
        "idempotency-key": `dev-pulse-brief-${args.weekStart}-v${args.version ?? 1}`,
      },
      body: JSON.stringify({
        from: "JARVIS <onboarding@resend.dev>",
        to: [to],
        subject: `JARVIS: developer pain points, week of ${args.weekStart}`,
        html: args.brief ? renderFridayHtml(args.brief, dashboardUrl(env)) : renderBriefHtml(args.weekStart, args.narrative, args.points, dashboardUrl(env), args.comparison ?? null),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (e) {
    throw new EmailSendError(`resend request failed before a response (${(e as Error)?.name ?? "error"})`, false); // outcome unknown
  }
  if (!res.ok) {
    const definite = res.status >= 400 && res.status < 500 && res.status !== 409;
    throw new EmailSendError(`resend http ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`, definite);
  }
  let messageId: string | null = null;
  try { messageId = ((await res.json()) as { id?: string }).id ?? null; } catch { /* the message was accepted either way */ }
  return { status: "sent", messageId };
}

/**
 * A clearly labelled REHEARSAL copy of the latest saved brief, to the configured recipient only. It is for checking that the inbox
 * path works. It never touches the saved report or its delivery state, never uses the real idempotency key (so it can neither be
 * mistaken for, nor block, the real Friday send), and is only reachable from a script: there is no route that calls it.
 */
export async function sendRehearsalEmail(
  args: { brief: FridayBrief; nonce: string },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<"skipped" | { status: "sent"; messageId: string | null }> {
  const key = env.RESEND_API_KEY;
  const to = env.DIGEST_TO_EMAIL;
  if (!key || !to) return "skipped";
  const banner = `<div style="font-family:system-ui,sans-serif;max-width:620px;background:#fff4d6;border:1px solid #e0b84c;padding:10px 14px;margin-bottom:14px;border-radius:6px"><strong>Rehearsal.</strong> This is a practice copy of the saved report for ${esc(args.brief.periodLabel)}, sent to check that email reaches your inbox. The real weekly email is separate and was not changed.</div>`;
  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": `jarvis-rehearsal-${args.brief.weekStart}-${args.nonce}` },
      body: JSON.stringify({ from: "JARVIS <onboarding@resend.dev>", to: [to], subject: `[Rehearsal] JARVIS: developer pain points, week of ${args.brief.weekStart}`, html: banner + renderFridayHtml(args.brief, dashboardUrl(env)) }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (e) {
    throw new EmailSendError(`resend request failed before a response (${(e as Error)?.name ?? "error"})`, false);
  }
  if (!res.ok) throw new EmailSendError(`resend http ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`, res.status >= 400 && res.status < 500 && res.status !== 409);
  let messageId: string | null = null;
  try { messageId = ((await res.json()) as { id?: string }).id ?? null; } catch { /* accepted either way */ }
  return { status: "sent", messageId };
}
