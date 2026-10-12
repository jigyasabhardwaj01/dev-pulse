import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fridayStatus, invokedBy, maskEmail, type Setup } from "@/lib/friday-status";
import FridayCard from "@/components/FridayCard";
import { readSchedule } from "@/lib/schedule";
import vercelConfig from "../vercel.json";

const setup = (o: Partial<Setup> = {}): Setup => ({ schedule: readSchedule(vercelConfig), aiKey: true, emailKey: true, recipient: "jigyasa@pg27.mesaschool.co", cronSecret: true, ...o });
const run = (o: object = {}): any => ({ id: "r", status: "succeeded", startedAt: "2026-10-09T00:31:00Z", finishedAt: "2026-10-09T00:33:00Z", emailStatus: "sent", diagnostics: [], sources: [], ...o });
const cron = (o: object = {}) => run({ diagnostics: [{ code: "RUN_INVOKED", detail: { by: "vercel-cron" } }], ...o });
const report = (o: object = {}): any => ({ periodLabel: "Fri 2 Oct – Thu 8 Oct 2026 (IST)", generatedAt: "2026-10-09T00:32:00Z", delivery: { status: "sent", sentAt: "2026-10-09T00:33:00Z", version: 1 }, ...o });
const NOW = new Date("2026-10-12T18:00:00Z"); // Monday evening IST
const st = (o: Partial<Parameters<typeof fridayStatus>[0]> = {}) => fridayStatus({ now: NOW, setup: setup(), report: report(), runs: [run()], ...o });

describe("next scheduled email", () => {
  it("is the coming Friday 06:00 IST and covers the seven days that end the day before", () => {
    const s = st();
    expect(s.next.when?.toISOString()).toBe("2026-10-16T00:30:00.000Z");
    expect(s.next.label).toMatch(/Friday 16 October 2026 at 06:00 IST/);
    expect(s.next.period).toMatch(/9 Oct.*15 Oct 2026/);
  });
  it("on Friday before 06:00 IST the next run is that same morning; just after it, next week", () => {
    expect(st({ now: new Date("2026-10-16T00:00:00Z") }).next.when?.toISOString()).toBe("2026-10-16T00:30:00.000Z");
    expect(st({ now: new Date("2026-10-16T00:31:00Z") }).next.when?.toISOString()).toBe("2026-10-23T00:30:00.000Z");
    expect(st({ now: new Date("2026-10-16T00:30:00Z") }).next.when?.toISOString()).toBe("2026-10-23T00:30:00.000Z"); // exactly due: that one is now
  });
  it("shows the recipient masked, never in full, on a public page", () => {
    expect(st().next.recipient).toBe("jig***@pg27.mesaschool.co");
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
    expect(maskEmail("")).toBeNull(); expect(maskEmail("not-an-email")).toBeNull(); expect(maskEmail(undefined)).toBeNull();
  });
});

describe("will it arrive automatically?", () => {
  it("configured but no schedule-started run yet: yes, scheduled, explicitly NOT proven", () => {
    const s = st({ runs: [run({ diagnostics: [{ code: "RUN_INVOKED", detail: { by: "manual" } }] })] });
    expect(s.verdict).toMatchObject({ tone: "warn", headline: "Yes, it is scheduled, but not yet proven" });
    expect(s.proven).toBe(false);
    expect(s.actions).toEqual([]);
  });
  it("a manual call that sent an email never counts as proof", () => {
    expect(st({ runs: [run({ diagnostics: [{ code: "RUN_INVOKED", detail: { by: "manual" } }], emailStatus: "sent" })] }).proven).toBe(false);
    expect(st({ runs: [run({ emailStatus: "sent" })] }).proven).toBe(false); // older run with no record of who started it
  });
  it("proven only by a Vercel-started run that finished and delivered (or found it already delivered)", () => {
    expect(st({ runs: [cron()] }).verdict.headline).toBe("Yes, it arrives automatically");
    expect(st({ runs: [cron({ emailStatus: "already_sent" })] }).proven).toBe(true);
    expect(st({ runs: [cron({ status: "partial" })] }).proven).toBe(false);
    expect(st({ runs: [cron({ emailStatus: "failed" })] }).proven).toBe(false);
    expect(st({ runs: [cron({ emailStatus: null })] }).proven).toBe(false);
  });
  it("each missing setting says no, names the fix, and never says yes", () => {
    const cases: [Partial<Setup>, RegExp][] = [
      [{ aiKey: false }, /OPENROUTER_API_KEY/], [{ emailKey: false }, /RESEND_API_KEY/], [{ recipient: null }, /DIGEST_TO_EMAIL/], [{ recipient: "garbage" }, /DIGEST_TO_EMAIL/],
      [{ cronSecret: false }, /CRON_SECRET/], [{ schedule: { state: "paused", crons: [] } }, /schedule is not configured/], [{ schedule: { state: "unknown", crons: null } }, /schedule is not configured/],
    ];
    for (const [o, re] of cases) {
      const s = st({ setup: setup(o), runs: [cron()] });
      expect(s.verdict.tone).toBe("bad");
      expect(s.verdict.headline).not.toMatch(/^Yes/);
      expect(s.actions.join(" ")).toMatch(re);
    }
  });
  it("a schedule for another path does not count", () => {
    const s = st({ setup: setup({ schedule: { state: "configured", crons: [{ path: "/api/other", schedule: "30 0 * * 5" }] } }) });
    expect(s.next.when).toBeNull(); expect(s.next.label).toBe("Not scheduled"); expect(s.verdict.tone).toBe("bad");
  });
  it("an expression that is not a plain weekly one is not guessed at", () => {
    const s = st({ setup: setup({ schedule: { state: "configured", crons: [{ path: "/api/cron/weekly-digest", schedule: "*/5 * * * *" }] } }) });
    expect(s.next.when).toBeNull(); expect(s.verdict.tone).toBe("bad");
  });
});

describe("last run, last report, last email, action required", () => {
  it("a failed or partial last run asks the owner to look, and says the next run retries", () => {
    for (const status of ["failed", "partial"]) {
      const s = st({ runs: [run({ status })] });
      expect(s.lastRun.tone).toBe(status === "failed" ? "bad" : "warn");
      expect(s.actions.join(" ")).toMatch(/Technical status/);
    }
  });
  it("an unconfirmed email tells the owner to check the inbox and that it will not resend; a failed one says it retries", () => {
    expect(st({ runs: [run({ emailStatus: "unconfirmed" })] }).actions.join(" ")).toMatch(/Check your inbox first.*not resend/);
    expect(st({ runs: [run({ emailStatus: "failed" })] }).actions.join(" ")).toMatch(/retries/);
  });
  it("delivery wording follows the saved report, never the run alone", () => {
    expect(st().lastEmail).toMatchObject({ tone: "ok", headline: "Yes, this report was emailed" });
    expect(st({ report: report({ delivery: { status: "sent", sentAt: "2026-10-09T00:33:00Z" } }) }).lastEmail.detail).toMatch(/spam/);
    expect(st({ report: report({ delivery: { status: "failed" } }) }).lastEmail.tone).toBe("warn");
    expect(st({ report: report({ delivery: { status: "sending" } }) }).lastEmail.headline).toMatch(/being sent/);
    expect(st({ report: report({ delivery: { status: "not_sent" } }) }).lastEmail.headline).toBe("Not emailed yet");
    expect(st({ report: report({ delivery: { status: "unknown" } }) }).lastEmail.headline).toBe("Not recorded");
    expect(st({ report: null }).lastEmail.headline).toBe("No email yet");
    expect(st({ report: null }).lastReport.headline).toBe("No report saved yet");
  });
  it("a finished run is not described as a delivered email, and a run in progress is not a failure", () => {
    const s = st({ report: report({ delivery: { status: "not_sent" } }), runs: [run({ emailStatus: null })] });
    expect(s.lastRun.headline).toBe("The last run finished");
    expect(s.lastEmail.headline).toBe("Not emailed yet");
    expect(st({ runs: [run({ status: "running" })] }).lastRun.headline).toMatch(/in progress/);
  });
  it("unreadable or empty run history is stated, not hidden", () => {
    expect(st({ runs: null }).lastRun.headline).toBe("Run history could not be read");
    expect(st({ runs: [] }).lastRun.headline).toBe("No run recorded yet");
  });
  it("with everything healthy there is nothing for the owner to do", () => {
    expect(st({ runs: [cron()] }).actions).toEqual([]);
  });
  it("invokedBy reads only the recorded diagnostic", () => {
    expect(invokedBy(cron())).toBe("vercel-cron"); expect(invokedBy(run())).toBeNull();
    expect(invokedBy(run({ diagnostics: [{ code: "RUN_INVOKED", detail: { by: "hacker" } }] }))).toBeNull();
  });
});

describe("FridayCard", () => {
  const html = (s = st()) => renderToStaticMarkup(<FridayCard s={s} />);
  it("answers the six questions with the four headings and explains there is no send button", () => {
    const o = html();
    for (const t of ["Next email", "Last run", "Last report", "Last email", "Action required", "Your Friday email"]) expect(o).toContain(t);
    expect(o).toContain("You never have to press anything"); expect(o).toContain("There is no button that sends the weekly email"); expect(o).toContain("[Rehearsal]");
    expect(o).toContain("jig***@pg27.mesaschool.co"); expect(o).not.toContain("jigyasa@");
    expect(o).toContain("up to an hour late");
  });
  it("shows the action list when something needs doing, and 'Nothing' otherwise", () => {
    expect(html(st({ setup: setup({ aiKey: false }) }))).toContain("OPENROUTER_API_KEY");
    expect(html(st({ runs: [cron()] }))).toContain("Nothing. You do not need to do anything.");
  });
});
