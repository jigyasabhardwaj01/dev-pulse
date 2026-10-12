import type { FetchedPost } from "./types";

export const postKey = (p: Pick<FetchedPost, "source" | "source_id">) => `${p.source}:${p.source_id}`;

/** Drops posts already stored and repeats inside the batch itself (first occurrence wins). */
export function dedupePosts<T extends FetchedPost>(posts: T[], existingKeys: Set<string>): T[] {
  const seen = new Set(existingKeys);
  const out: T[] = [];
  for (const p of posts) {
    const k = postKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}
