import { makeHnFetcher } from "./sources/hn";
import { makeSoFetcher } from "./sources/stackoverflow";
import { makeRedditFetcher } from "./sources/reddit";
import { makeGithubFetcher } from "./sources/github";
import { openRouterFromEnv } from "./openrouter";
import { redditAccessFrom } from "./sources/reddit-access";
import { sanitizeError } from "./text";
import type { Deps } from "./pipeline";

/** The real sources and AI caller for a run. Shared by the Friday job and the Start Research button, so they can never drift apart. */
export function productionRunDeps(env: NodeJS.ProcessEnv = process.env): Pick<Deps, "fetchers" | "callModel" | "notCollected"> {
  let callModel: Deps["callModel"] = null;
  try {
    callModel = openRouterFromEnv();
  } catch (e) {
    console.error("ai unavailable:", sanitizeError(e));
  }
  const reddit = redditAccessFrom(env);
  return {
    fetchers: {
      hn: makeHnFetcher(),
      stackoverflow: makeSoFetcher(fetch, env.STACKEXCHANGE_KEY),
      // Reddit is collected only through a supported, reliable method (see BACKEND.md section 19); otherwise the report says "not collected".
      ...(reddit.enabled ? { reddit: makeRedditFetcher(fetch, undefined, { clientId: env.REDDIT_CLIENT_ID, clientSecret: env.REDDIT_CLIENT_SECRET }) } : {}),
      github: makeGithubFetcher(fetch, env.GITHUB_TOKEN),
    },
    callModel,
    notCollected: reddit.enabled ? undefined : { reddit: reddit.reason },
  };
}
