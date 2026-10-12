import type { FetchLike, ThemeTrend } from "./types";
import { comparisonCaveats, comparisonNote, type Comparison, type Coverage } from "./coverage";
import { formatPeriod } from "./view";
import { groupPainPoints, mentionsLine, trendArrow, trendLabel } from "./grouping";

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
<h2 style="margin:0 0 4px">Dev Pulse · week of ${esc(weekStart)}</h2>
${formatPeriod(weekStart) ? `<div style="color:#555;margin-bottom:2px">${esc(formatPeriod(weekStart))}</div>` : ""}
<div style="color:#555;margin-bottom:10px">${allPoints.reduce((s, p) => s + p.count, 0)} mentions matched to tracked themes across ${allPoints.filter((p) => p.count > 0).length} pain points</div>
<p style="margin:0 0 6px">${esc(narrative)}</p>${note}${body}${more}${link}</div>`;
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
  args: { weekStart: string; version?: number; narrative: string; points: ThemeTrend[]; comparison?: Comparison | null; coverage?: Coverage },
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
        from: "Dev Pulse <onboarding@resend.dev>",
        to: [to],
        subject: `Dev Pulse: developer pain points, week of ${args.weekStart}`,
        html: renderBriefHtml(args.weekStart, args.narrative, args.points, dashboardUrl(env), args.comparison ?? null),
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
