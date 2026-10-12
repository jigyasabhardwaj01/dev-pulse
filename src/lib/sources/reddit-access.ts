/** Whether Reddit is collected, and if not, the plain reason shown on the report. */
export function redditAccessFrom(env: NodeJS.ProcessEnv): { enabled: true; method: "oauth" | "public" } | { enabled: false; reason: string } {
  if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) return { enabled: true, method: "oauth" };
  if (env.REDDIT_PUBLIC_ENABLED === "1") return { enabled: true, method: "public" };
  return { enabled: false, reason: "Reddit's public feed was rate limited (HTTP 429) when requested from the hosting provider, and no Reddit API credentials are configured" };
}
