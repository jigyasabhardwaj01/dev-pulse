import { describe, expect, it } from "vitest";
import { periodFor } from "@/lib/week";
import { planRun } from "@/lib/run-plan";

const iso = (d: Date) => d.toISOString();

describe("reporting period: Friday 00:00 IST .. Thursday 23:59:59.999 IST", () => {
  // IST = UTC+05:30. 2026-10-09 is a Friday.
  it("a Friday-morning run reports the seven complete days before that Friday", () => {
    const p = periodFor(new Date("2026-10-09T03:30:00Z")); // Fri 09:00 IST
    expect(iso(p.start)).toBe("2026-10-01T18:30:00.000Z"); // Fri 2026-10-02 00:00:00.000 IST
    expect(iso(p.end)).toBe("2026-10-08T18:30:00.000Z"); //   Fri 2026-10-09 00:00:00.000 IST (exclusive)
    expect(p.weekStart).toBe("2026-10-02");
    expect(p.prevWeekStart).toBe("2026-09-25");
    expect(iso(p.prevStart)).toBe("2026-09-24T18:30:00.000Z");
  });

  it("excludes the incomplete current Friday and includes Thursday 23:59:59.999 IST", () => {
    const p = periodFor(new Date("2026-10-09T03:30:00Z"));
    const lastMs = new Date("2026-10-08T18:29:59.999Z").getTime(); // Thu 23:59:59.999 IST
    const firstOfFriday = new Date("2026-10-08T18:30:00.000Z").getTime(); // Fri 00:00:00.000 IST
    expect(lastMs >= p.start.getTime() && lastMs < p.end.getTime()).toBe(true);
    expect(firstOfFriday >= p.end.getTime()).toBe(true);
  });

  it("the period is exactly 7 x 24 h and the previous one ends exactly where this one starts", () => {
    const p = periodFor(new Date("2026-10-09T03:30:00Z"));
    expect(p.end.getTime() - p.start.getTime()).toBe(7 * 86_400_000);
    expect(p.start.getTime() - p.prevStart.getTime()).toBe(7 * 86_400_000);
  });

  it("boundary instants: the last millisecond before Friday 00:00 IST still belongs to the previous Friday's run", () => {
    expect(periodFor(new Date("2026-10-08T18:29:59.999Z")).weekStart).toBe("2026-09-25"); // Thu 23:59:59.999 IST
    expect(periodFor(new Date("2026-10-08T18:30:00.000Z")).weekStart).toBe("2026-10-02"); // Fri 00:00:00.000 IST
  });

  it("UTC date differs from IST date near midnight: Thu 20:00 UTC is already Fri 01:30 IST", () => {
    const p = periodFor(new Date("2026-10-08T20:00:00Z"));
    expect(iso(p.end)).toBe("2026-10-08T18:30:00.000Z");
    expect(p.weekStart).toBe("2026-10-02");
  });

  it("a mid-week run (e.g. Monday) is deterministic: the most recent completed Friday-to-Thursday week", () => {
    expect(periodFor(new Date("2026-10-12T05:00:00Z")).weekStart).toBe("2026-10-02"); // Monday
    expect(periodFor(new Date("2026-10-14T23:00:00Z")).weekStart).toBe("2026-10-02"); // Thu 04:30 IST, still before that Friday
    expect(periodFor(new Date("2026-10-15T20:00:00Z")).weekStart).toBe("2026-10-09"); // Fri 01:30 IST
  });

  it("every period key is a Friday", () => {
    for (const d of ["2026-10-09T03:30:00Z", "2026-10-12T05:00:00Z", "2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z"]) {
      expect(new Date(`${periodFor(new Date(d)).weekStart}T00:00:00Z`).getUTCDay()).toBe(5);
    }
  });

  it("has no DST shift across a year boundary (fixed +05:30)", () => {
    const p = periodFor(new Date("2027-01-01T03:30:00Z")); // Fri 2027-01-01 09:00 IST
    expect(iso(p.end)).toBe("2026-12-31T18:30:00.000Z");
    expect(p.weekStart).toBe("2026-12-25");
  });
});

describe("run planning: backfills are deterministic and never email", () => {
  it("no asOf = scheduled run that may email", () => {
    const now = new Date("2026-10-09T03:30:00Z");
    expect(planRun(null, now)).toEqual({ now, trigger: "scheduled", allowEmail: true });
  });
  it("asOf = backfill that must not email", () => {
    const plan = planRun("2026-10-09");
    expect(plan).toMatchObject({ trigger: "backfill", allowEmail: false });
    expect(periodFor((plan as { now: Date }).now).weekStart).toBe("2026-10-02"); // an IST Friday asOf selects the week ending that morning
  });
  it("is deterministic: the same asOf always selects the same period regardless of today's date", () => {
    const a = planRun("2026-10-05") as { now: Date };
    const b = planRun("2026-10-05") as { now: Date };
    expect(periodFor(a.now)).toEqual(periodFor(b.now));
    expect(periodFor(a.now).weekStart).toBe("2026-09-25"); // Monday 2026-10-05 -> week ending Fri 2026-10-02 morning
  });
  it("rejects malformed dates with a 400", () => {
    for (const bad of ["", "yesterday", "2026-13-40", "2026-10-9", "2026-10-09T00:00:00Z"]) {
      expect(planRun(bad)).toMatchObject({ status: 400 });
    }
  });
});
