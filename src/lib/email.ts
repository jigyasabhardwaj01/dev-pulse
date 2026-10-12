import type { FetchLike, ThemeTrend } from "./types";
import { groupPainPoints, mentionsLine, trendArrow, trendLabel } from "./grouping";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const dashboardUrl = (env: NodeJS.ProcessEnv = process.env) =>
  (env.APP_URL || "").replace(/\/+$/, "") || null;

/** Headline + context line + grouped list + dashboard link. Same grouping as the dashboard. */
export const EMAIL_MAX_ITEMS = 10;

export function renderBriefHtml(weekStart: string, narrative: string, allPoints: ThemeTrend[], appUrl: string | null): string {
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
  const link = appUrl ? `<p style="margin-top:20px"><a href="${esc(appUrl)}">View the full dashboard and underlying posts →</a></p>` : "";
  return `<div style="font-family:system-ui,sans-serif;max-width:620px;line-height:1.5">
<h2 style="margin:0 0 4px">Dev Pulse · week of ${esc(weekStart)}</h2>
<div style="color:#555;margin-bottom:10px">${groupPainPoints(allPoints).reduce((s, g) => s + g.totalMentions, 0)} mentions across ${allPoints.length} pain points</div>
<p style="margin:0 0 6px">${esc(narrative)}</p>${body}${more}${link}</div>`;
}

/** Resend free tier. From onboarding@resend.dev, which can only deliver to the Resend account owner's address. */
export async function sendBriefEmail(
  args: { weekStart: string; narrative: string; points: ThemeTrend[] },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<"sent" | "skipped"> {
  const key = env.RESEND_API_KEY;
  const to = env.DIGEST_TO_EMAIL;
  if (!key || !to) return "skipped";
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: "Dev Pulse <onboarding@resend.dev>",
      to: [to],
      subject: `Dev Pulse: developer pain points, week of ${args.weekStart}`,
      html: renderBriefHtml(args.weekStart, args.narrative, args.points, dashboardUrl(env)),
    }),
  });
  if (!res.ok) throw new Error(`resend http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return "sent";
}
