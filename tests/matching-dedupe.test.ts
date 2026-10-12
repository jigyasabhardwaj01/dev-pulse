import { describe, expect, it } from "vitest";
import { matchesKeywords, matchKeyword } from "@/lib/matching";
import { dedupePosts } from "@/lib/dedupe";
import { stripHtml } from "@/lib/text";
import { periodFor } from "@/lib/week";
import { post } from "./helpers";

describe("keyword matching", () => {
  it("is case-insensitive and whole-word", () => {
    expect(matchesKeywords("Our Code Review process", ["code review"])).toBe(true);
    expect(matchesKeywords("barcode reviewer", ["code review"])).toBe(false);
  });
  it("treats hyphen/underscore as a space and escapes regex chars", () => {
    expect(matchesKeywords("code-review fatigue", ["code review"])).toBe(true);
    expect(matchesKeywords("we use CI/CD daily", ["ci/cd"])).toBe(true);
    expect(matchesKeywords("anything", ["a.*"])).toBe(false);
  });
  it("returns the matched keyword, null when none, ignores blanks", () => {
    expect(matchKeyword("flaky tests again", ["", "flaky tests"])).toBe("flaky tests");
    expect(matchKeyword("nothing here", ["flaky tests"])).toBeNull();
  });
});

describe("dedupe", () => {
  it("drops stored keys and in-batch repeats, keeping the first", () => {
    const out = dedupePosts(
      [post({ source_id: "a" }), post({ source_id: "b" }), post({ source_id: "b", title: "dup" }), post({ source: "stackoverflow", source_id: "a" })],
      new Set(["hn:a"]),
    );
    expect(out.map((p) => `${p.source}:${p.source_id}`)).toEqual(["hn:b", "stackoverflow:a"]);
    expect(out[0].title).not.toBe("dup");
  });
  it("same source_id on different sources are distinct", () => {
    expect(dedupePosts([post({ source_id: "1" }), post({ source: "stackoverflow", source_id: "1" })], new Set())).toHaveLength(2);
  });
});

describe("helpers", () => {
  it("strips html and entities", () => {
    expect(stripHtml("<p>a &amp; b</p><pre>code</pre>")).toBe("a & b");
  });
  it("builds contiguous equal-length windows", () => {
    const w = periodFor(new Date("2026-10-09T03:30:00Z"));
    expect(w.end.getTime() - w.start.getTime()).toBe(7 * 86_400_000);
    expect(w.start.getTime() - w.prevStart.getTime()).toBe(7 * 86_400_000);
    expect(w.weekStart).toBe("2026-10-02");
    expect(w.prevWeekStart).toBe("2026-09-25");
  });
});
