import type { FetchLike, ThemeTrend } from "./types";
import { describeTrend } from "./brief";

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export function renderBriefHtml(weekStart: string, narrative: string, points: ThemeTrend[]): string {
  const items = points
    .map((t) => `<li><strong>${esc(t.topic_name)} · ${esc(t.theme)}</strong> — ${esc(describeTrend(t))}${t.unresolved ? " <em>(unresolved)</em>" : ""}</li>`)
    .join("");
  const paras = narrative.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  return `<div style="font-family:system-ui,sans-serif;max-width:640px"><h2>Dev Pulse — week of ${weekStart}</h2>${paras}<h3>Pain points</h3><ol>${items}</ol></div>`;
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
      html: renderBriefHtml(args.weekStart, args.narrative, args.points),
    }),
  });
  if (!res.ok) throw new Error(`resend http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return "sent";
}
