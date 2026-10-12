import { describe, expect, it, vi } from "vitest";
import { classifyTopicPosts, countThemes, enforceTheme, resolveUnresolved } from "@/lib/classify";
import type { StoredPost } from "@/lib/types";
import { TOPIC, post } from "./helpers";

const stored = (i: number, over: Partial<StoredPost> = {}): StoredPost =>
  ({ ...post({ source_id: String(i) }), id: `p${i}`, theme: null, sentiment: null, unresolved: null, ...over });

describe("closed vocabulary", () => {
  it("accepts canonical themes case-insensitively", () => {
    expect(enforceTheme("  slow reviews ", TOPIC.canonical_themes)).toBe("Slow reviews");
  });
  it("maps invented, empty and non-string themes to 'other'", () => {
    for (const bad of ["Flaky CI", "", null, 42, undefined]) expect(enforceTheme(bad, TOPIC.canonical_themes)).toBe("other");
  });
  it("never lets a made-up label through classification", async () => {
    const model = vi.fn().mockResolvedValue(JSON.stringify([{ index: 0, theme: "Totally new theme", sentiment: "negative", unresolved: true }]));
    const out = await classifyTopicPosts(TOPIC, [stored(0)], model);
    expect(out.results[0].theme).toBe("other");
  });
  it("folds themes removed from the vocabulary into 'other' when counting", () => {
    const counts = countThemes([{ topic_id: "t1", theme: "Retired theme", unresolved: false }, { topic_id: "t1", theme: "Slow reviews", unresolved: true }], [TOPIC]);
    expect(counts).toEqual(expect.arrayContaining([
      { topic_id: "t1", theme: "other", count: 1, unresolved: 0 },
      { topic_id: "t1", theme: "Slow reviews", count: 1, unresolved: 1 },
    ]));
  });
});

describe("unresolved signal", () => {
  it("uses is_answered for Stack Overflow, ignoring the model", () => {
    expect(resolveUnresolved({ source: "stackoverflow", is_answered: true }, true)).toBe(false);
    expect(resolveUnresolved({ source: "stackoverflow", is_answered: false }, false)).toBe(true);
  });
  it("uses the model's judgment for Hacker News", () => {
    expect(resolveUnresolved({ source: "hn", is_answered: null }, true)).toBe(true);
    expect(resolveUnresolved({ source: "hn", is_answered: null }, "yes")).toBe(false);
  });
});

describe("classification resilience", () => {
  it("leaves a post missing from the response unclassified without losing the rest", async () => {
    const model = vi.fn().mockResolvedValue(JSON.stringify([{ index: 0, theme: "False positives", sentiment: "negative", unresolved: false }]));
    const out = await classifyTopicPosts(TOPIC, [stored(0), stored(1)], model);
    expect(out.results.map((r) => r.id)).toEqual(["p0"]);
    expect(out.missing.map((p) => p.id)).toEqual(["p1"]);
  });
  it("survives malformed JSON, fences, and a throwing model", async () => {
    expect((await classifyTopicPosts(TOPIC, [stored(0)], async () => "not json")).missing).toHaveLength(1);
    expect((await classifyTopicPosts(TOPIC, [stored(0)], async () => { throw new Error("down"); })).missing).toHaveLength(1);
    const fenced = "```json\n[{\"index\":0,\"theme\":\"Slow reviews\",\"sentiment\":\"bogus\",\"unresolved\":true}]\n```";
    const ok = await classifyTopicPosts(TOPIC, [stored(0)], async () => fenced);
    expect(ok.results[0]).toMatchObject({ theme: "Slow reviews", sentiment: "neutral", unresolved: true });
  });
  it("ignores out-of-range and duplicate indexes", async () => {
    const model = async () => JSON.stringify([{ index: 9, theme: "Slow reviews", unresolved: false }, { index: 0, theme: "Slow reviews", unresolved: false }, { index: 0, theme: "False positives", unresolved: false }]);
    const out = await classifyTopicPosts(TOPIC, [stored(0)], model);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].theme).toBe("Slow reviews");
  });
  it("overrides model guess with is_answered on Stack Overflow posts", async () => {
    const so = stored(0, { source: "stackoverflow", is_answered: true });
    const out = await classifyTopicPosts(TOPIC, [so], async () => JSON.stringify([{ index: 0, theme: "Slow reviews", sentiment: "negative", unresolved: true }]));
    expect(out.results[0].unresolved).toBe(false);
  });
});
