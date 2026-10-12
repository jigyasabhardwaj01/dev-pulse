import { describe, expect, it } from "vitest";
import {
  acceptsConfidence, ambiguityOf, checkTermChange, classificationPolicy, countTermMatches, diffTerms, effectiveTopic, matchPost, normalizeTerm,
  sameConfig, snapshotConfig, termActivity, type EffectiveTopic, type WatchTerm,
} from "@/lib/watchlist";
import type { Topic } from "@/lib/types";

const topic = (over: Partial<Topic> = {}): Topic => ({ id: "t1", name: "Code review", keywords: ["code review", "false positive"], canonical_themes: ["Slow reviews"], tags: [], category: null, active: true, ...over });
let n = 0;
const term = (over: Partial<WatchTerm> & Pick<WatchTerm, "term">): WatchTerm => ({ id: `w${++n}`, topic_id: "t1", kind: "include", status: "active", applies_to: null, ...over });
const eff = (terms: WatchTerm[], t = topic()): EffectiveTopic => effectiveTopic(t, terms);
const post = (title: string, body = "") => ({ title, body });

describe("normalizeTerm", () => {
  it("trims, collapses whitespace, lowercases and drops wrapping quotes", () => {
    for (const [raw, out] of [["  Code   Review ", "code review"], ['"Pull Request Review"', "pull request review"], ["CI/CD", "ci/cd"], ["C++", "c++"], ["node.js", "node.js"], ["merge\tconflicts\n", "merge conflicts"], ["`github actions`", "github actions"]] as const) {
      expect(normalizeTerm(raw)).toEqual({ ok: true, term: out });
    }
  });
  it("rejects what cannot be a search phrase", () => {
    for (const bad of ["", " ", "a", "x".repeat(81), "!!!", "---", "a;drop table", "foo|bar", "(x)", "<script>", 5, null, undefined, {}]) {
      expect(normalizeTerm(bad as never).ok, String(bad)).toBe(false);
    }
  });
  it("accepts the boundary lengths", () => {
    expect(normalizeTerm("ab").ok).toBe(true);
    expect(normalizeTerm("a".repeat(80)).ok).toBe(true);
  });
  it("strips control characters instead of storing them", () => {
    expect(normalizeTerm("code\u0000 review\u0007")).toEqual({ ok: true, term: "code review" });
  });
});

describe("ambiguity", () => {
  it("flags common words and very short single words, not specific phrases", () => {
    for (const t of ["ci", "review", "workflow", "bot", "pr", "xyz"]) expect(ambiguityOf(t), t).not.toBeNull();
    for (const t of ["github actions", "pull request review", "merge conflicts", "flaky tests", "developer experience"]) expect(ambiguityOf(t), t).toBeNull();
  });
});

describe("checkTermChange", () => {
  const existing = [term({ id: "i1", term: "code review" }), term({ id: "i2", term: "false positive" }), term({ id: "x1", term: "job posting", kind: "exclude" }), term({ id: "o1", topic_id: "t2", term: "code review" })];
  const add = (c: Partial<Parameters<typeof checkTermChange>[1]> & { term: string }) => checkTermChange(existing, { topic_id: "t1", kind: "include", ...c });
  const errors = (ps: ReturnType<typeof checkTermChange>) => ps.filter((p) => p.level === "error").map((p) => p.message);
  it("rejects an exact duplicate in the same topic and kind, but not the same text in another topic", () => {
    expect(errors(add({ term: "code review" }))[0]).toContain("already");
    expect(errors(checkTermChange(existing, { topic_id: "t3", kind: "include", term: "code review" }))).toEqual([]);
  });
  it("rejects an include that is already an exclusion for the topic", () => {
    expect(errors(add({ term: "job posting" }))[0]).toContain("is an exclusion");
  });
  it("warns about ambiguous includes without blocking them", () => {
    const p = add({ term: "workflow" });
    expect(errors(p)).toEqual([]);
    expect(p.some((x) => x.level === "warning" && /common outside developer discussion/.test(x.message))).toBe(true);
  });
  it("refuses an exclusion that would swallow an include term (it would hide ALL its evidence)", () => {
    const p = checkTermChange(existing, { topic_id: "t1", kind: "exclude", term: "review" });
    expect(errors(p)[0]).toContain('every match for "code review"');
  });
  it("allows an exclusion scoped to a term that does not contain it, and refuses one scoped to a term that does", () => {
    expect(errors(checkTermChange(existing, { topic_id: "t1", kind: "exclude", term: "review", applies_to: "i2" }))).toEqual([]);
    expect(errors(checkTermChange(existing, { topic_id: "t1", kind: "exclude", term: "review", applies_to: "i1" }))[0]).toContain("every match");
  });
  it("rejects a scope that is not one of the topic's own include terms", () => {
    expect(errors(checkTermChange(existing, { topic_id: "t1", kind: "exclude", term: "spam", applies_to: "o1" }))[0]).toContain("own terms");
    expect(errors(checkTermChange(existing, { topic_id: "t1", kind: "exclude", term: "spam", applies_to: "nope" }))[0]).toContain("own terms");
  });
  it("warns that a single-word topic-wide exclusion is broad", () => {
    expect(checkTermChange(existing, { topic_id: "t1", kind: "exclude", term: "hiring" }).some((p) => p.level === "warning" && /single word/.test(p.message))).toBe(true);
  });
  it("the same exclusion text may exist both topic-wide and scoped, but not twice with the same scope", () => {
    expect(errors(checkTermChange(existing, { topic_id: "t1", kind: "exclude", term: "job posting", applies_to: "i2" }))).toEqual([]);
    expect(errors(checkTermChange(existing, { topic_id: "t1", kind: "exclude", term: "job posting" }))[0]).toContain("already");
  });
  it("editing a term does not collide with itself", () => {
    expect(errors(checkTermChange(existing, { topic_id: "t1", kind: "include", term: "code review" }, "i1"))).toEqual([]);
  });
});

describe("effectiveTopic", () => {
  it("falls back to the legacy keywords when a topic has no watch terms", () => {
    const e = effectiveTopic(topic(), []);
    expect(e).toMatchObject({ legacy: true, includes: ["code review", "false positive"], keywords: ["code review", "false positive"], excludes: [] });
  });
  it("the adapters' `keywords` are exactly the ACTIVE includes; paused ones are reported, exclusions resolve their scope", () => {
    const a = term({ id: "a", term: "code review" }), b = term({ id: "b", term: "false positive", status: "paused" });
    const x = term({ term: "job posting", kind: "exclude", applies_to: "a" }), y = term({ term: "hiring", kind: "exclude" }), z = term({ term: "dormant", kind: "exclude", status: "paused" });
    const e = eff([a, b, x, y, z]);
    expect(e.keywords).toEqual(["code review"]);
    expect(e).toMatchObject({ legacy: false, paused: ["false positive"], excludes: [{ term: "job posting", appliesTo: "code review" }, { term: "hiring", appliesTo: null }] });
  });
  it("a topic whose terms are all paused monitors nothing rather than silently reverting to legacy keywords", () => {
    expect(eff([term({ term: "code review", status: "paused" })]).keywords).toEqual([]);
  });
  it("ignores other topics' terms", () => {
    expect(eff([term({ topic_id: "t2", term: "other topic term" })]).legacy).toBe(true);
  });
});

describe("matchPost: deterministic matching and exclusions", () => {
  const T = eff([term({ id: "a", term: "code review" }), term({ id: "b", term: "false positive" })]);
  it("no active include term in the text is a rejection with the reason", () => {
    expect(matchPost(post("Cooking tips"), T, "balanced")).toMatchObject({ accepted: false, reason: "no_match" });
  });
  it("matches whole words only, case-insensitively, and records which terms matched", () => {
    expect(matchPost(post("Code Review is slow", "so many False Positives"), T, "balanced")).toMatchObject({ accepted: true, terms: ["code review"] });
    expect(matchPost(post("encode reviewer"), T, "balanced").accepted).toBe(false);
  });
  it("flags title versus body-only matches", () => {
    expect(matchPost(post("code review pain"), T, "balanced").flags).toContain("title_match");
    expect(matchPost(post("Rant", "code review pain"), T, "balanced").flags).toContain("body_only");
  });
  it("a topic-wide exclusion in the TITLE rejects the post", () => {
    const e = eff([term({ id: "a", term: "code review" }), term({ term: "job posting", kind: "exclude" })]);
    expect(matchPost(post("Job posting: code review engineer"), e, "balanced")).toMatchObject({ accepted: false, reason: "excluded", excludedBy: "job posting" });
  });
  it("a topic-wide exclusion that appears only in the BODY does not hide a post whose TITLE matches (strong evidence survives)", () => {
    const e = eff([term({ id: "a", term: "code review" }), term({ term: "hiring", kind: "exclude" })]);
    const r = matchPost(post("code review is broken", "we are hiring for this"), e, "balanced");
    expect(r.accepted).toBe(true);
    expect(r.flags).toContain("exclusion_overridden");
  });
  it("a topic-wide exclusion in the body DOES remove a post that matched only in the body", () => {
    const e = eff([term({ id: "a", term: "code review" }), term({ term: "hiring", kind: "exclude" })]);
    expect(matchPost(post("Who is hiring? January", "we use code review, hiring now"), e, "balanced")).toMatchObject({ accepted: false, reason: "excluded" });
  });
  it("a SCOPED exclusion removes a post only when the scoped term is the only one it matched", () => {
    const e = eff([term({ id: "a", term: "code review" }), term({ id: "b", term: "false positive" }), term({ term: "medical", kind: "exclude", applies_to: "b" })]);
    expect(matchPost(post("false positive rate in medical tests"), e, "balanced")).toMatchObject({ accepted: false, reason: "excluded" });
    const both = matchPost(post("false positive in medical code review"), e, "balanced");
    expect(both.accepted).toBe(true);                                   // another term matched: the scoped exclusion does not apply
    expect(both.flags).toContain("exclusion_overridden");
    expect(matchPost(post("code review", "medical"), e, "balanced").accepted).toBe(true); // unrelated term unaffected
  });
  it("an exclusion in one topic cannot affect another topic", () => {
    const a = eff([term({ id: "a", term: "code review" }), term({ term: "job posting", kind: "exclude" })]);
    const b = effectiveTopic(topic({ id: "t2", name: "CI" }), [term({ topic_id: "t2", term: "code review" })]);
    const p = post("Job posting: code review engineer");
    expect(matchPost(p, a, "balanced").accepted).toBe(false);
    expect(matchPost(p, b, "balanced").accepted).toBe(true);
  });
  it("paused terms never match", () => {
    expect(matchPost(post("code review"), eff([term({ term: "code review", status: "paused" })]), "balanced").accepted).toBe(false);
  });
});

describe("sensitivity modes behave differently on the same input (not a cosmetic setting)", () => {
  const T = eff([term({ id: "a", term: "code review" }), term({ id: "b", term: "false positive" }), term({ id: "c", term: "workflow" })]);
  const outcome = (p: { title: string; body: string }) => (["strict", "balanced", "early"] as const).map((m) => matchPost(p, T, m).accepted);
  it("strict rejects a single body-only match that balanced and early accept", () => {
    expect(outcome(post("Weekly thread", "we do code review sometimes"))).toEqual([false, true, true]);
  });
  it("strict accepts a body-only post with two distinct watched terms", () => {
    expect(outcome(post("Weekly thread", "code review and a false positive again"))).toEqual([true, true, true]);
  });
  it("strict accepts a title match", () => {
    expect(outcome(post("code review is painful"))).toEqual([true, true, true]);
  });
  it("an ambiguous-only body match is rejected by strict, accepted but FLAGGED by balanced", () => {
    const p = post("Thread", "our workflow is strange");
    expect(outcome(p)).toEqual([false, true, true]);
    expect(matchPost(p, T, "balanced").flags).toContain("ambiguous_term");
  });
  it("only early discovery accepts plural variants, and labels them", () => {
    const p = post("code reviews take forever");
    expect(outcome(p)).toEqual([false, false, true]);
    expect(matchPost(p, T, "early").flags).toContain("early_variant");
  });
  it("rejections carry the reason", () => {
    expect(matchPost(post("Thread", "we do code review sometimes"), T, "strict")).toMatchObject({ accepted: false, reason: "below_sensitivity" });
  });
});

describe("classification policy per mode", () => {
  it("has distinct, ordered thresholds", () => {
    const [s, b, e] = (["strict", "balanced", "early"] as const).map(classificationPolicy);
    expect([s.minConfidence, b.minConfidence, e.minConfidence]).toEqual([0.7, 0.5, 0.3]);
    expect(s.minConfidence).toBeGreaterThan(b.minConfidence);
    expect(b.minConfidence).toBeGreaterThan(e.minConfidence);
    expect([s.requireConfidence, b.requireConfidence, e.requireConfidence]).toEqual([true, false, false]);
    expect(e.earlySignalBelow).toBe(0.5);
    expect(s.earlySignalBelow).toBeNull();
  });
  it("each mode gives the model a different, explicit instruction", () => {
    const text = (["strict", "balanced", "early"] as const).map((m) => classificationPolicy(m).instruction);
    expect(new Set(text).size).toBe(3);
    expect(text[0]).toMatch(/STRICT.*relevant must be false/);
    expect(text[1]).toMatch(/BALANCED/);
    expect(text[2]).toMatch(/EARLY DISCOVERY.*LOW confidence/);
  });
  it("applies the confidence bar, a higher one for ambiguous-only matches, and handles a missing confidence per mode", () => {
    const [s, b, e] = (["strict", "balanced", "early"] as const).map(classificationPolicy);
    expect(acceptsConfidence(s, 0.69, false)).toBe(false);
    expect(acceptsConfidence(s, 0.7, false)).toBe(true);
    expect(acceptsConfidence(s, 0.75, true)).toBe(false);
    expect(acceptsConfidence(s, 0.8, true)).toBe(true);
    expect(acceptsConfidence(s, null, false)).toBe(false);   // strict never takes an unrated result
    expect(acceptsConfidence(b, null, false)).toBe(true);
    expect(acceptsConfidence(b, 0.49, false)).toBe(false);
    expect(acceptsConfidence(e, 0.3, false)).toBe(true);
    expect(acceptsConfidence(e, 0.29, false)).toBe(false);
    expect(acceptsConfidence(e, 0.4, true)).toBe(false);
  });
  it("an unknown mode falls back to balanced", () => {
    expect(classificationPolicy("loud" as never).mode).toBe("balanced");
  });
});

describe("configuration snapshot (reproducibility)", () => {
  const mk = () => {
    const terms = [term({ id: "a", term: "code review" }), term({ id: "b", term: "false positive", status: "paused" }), term({ term: "hiring", kind: "exclude" })];
    return { terms, e: eff(terms) };
  };
  it("records sensitivity, includes, paused terms and exclusions in a stable order", () => {
    const { e } = mk();
    const snap = snapshotConfig([e], "strict", new Date("2026-10-09T00:30:00Z"));
    expect(snap).toMatchObject({ version: 1, capturedAt: "2026-10-09T00:30:00.000Z", sensitivity: "strict", topics: [{ id: "t1", includes: ["code review"], paused: ["false positive"], excludes: [{ term: "hiring", appliesTo: null }] }] });
  });
  it("is unaffected by later edits to the watchlist (by value, not reference)", () => {
    const { e } = mk();
    const snap = snapshotConfig([e], "balanced", new Date("2026-10-09T00:30:00Z"));
    const frozen = JSON.stringify(snap);
    e.includes.push("added later"); e.excludes.push({ term: "x", appliesTo: null }); e.paused.length = 0;
    expect(JSON.stringify(snap)).toBe(frozen);
  });
  it("is deterministic regardless of input order, and sameConfig ignores only the capture time", () => {
    const a = mk().e;
    const b: EffectiveTopic = { ...a, includes: [...a.includes].reverse() };
    const s1 = snapshotConfig([a], "balanced", new Date("2026-10-09T00:30:00Z"));
    const s2 = snapshotConfig([b], "balanced", new Date("2026-10-16T00:30:00Z"));
    expect(sameConfig(s1, s2)).toBe(true);
    expect(sameConfig(s1, snapshotConfig([a], "strict", new Date("2026-10-09T00:30:00Z")))).toBe(false);
    expect(sameConfig(s1, null)).toBe(false);
  });
});

describe("term activity and audit diff", () => {
  it("classifies terms as paused, producing, low or none from real match counts", () => {
    expect(termActivity({ status: "paused", kind: "include" }, 9)).toBe("paused");
    expect(termActivity({ status: "active", kind: "include" }, 3)).toBe("producing");
    expect(termActivity({ status: "active", kind: "include" }, 2)).toBe("low");
    expect(termActivity({ status: "active", kind: "include" }, 0)).toBe("none");
    expect(termActivity({ status: "active", kind: "exclude" }, 4)).toBe("producing");
  });
  it("counts each post once per term, ignoring posts without stored terms", () => {
    const m = countTermMatches([{ matched_terms: ["a", "a", "b"] }, { matched_terms: ["a"] }, { matched_terms: null }, {}]);
    expect([m.get("a"), m.get("b")]).toEqual([2, 1]);
  });
  it("describes additions, removals, pauses, resumes and edits", () => {
    const a = term({ id: "1", term: "one" }), b = term({ id: "2", term: "two" });
    expect(diffTerms([a, b], [{ ...a, status: "paused" }, { ...b, term: "twelve" }, term({ id: "3", term: "three" })]).map((c) => `${c.action}:${c.subject}`).sort())
      .toEqual(["add:include:three", "edit:include:two", "pause:include:one"]);
    expect(diffTerms([a], []).map((c) => c.action)).toEqual(["remove"]);
    expect(diffTerms([{ ...a, status: "paused" }], [a]).map((c) => c.action)).toEqual(["resume"]);
  });
});
