import { describe, expect, it } from "vitest";
import { sendRehearsalEmail } from "@/lib/email";
import { latestSavedBrief } from "@/lib/pack-service";
import { makeSupabaseTeamStore } from "@/lib/team-store";

/** Developer tool, skipped unless LIVE_EMAIL is set. Sends ONE labelled rehearsal copy of the latest saved brief to DIGEST_TO_EMAIL. */
describe("live rehearsal email (dev tool)", () => {
  it.skipIf(!process.env.LIVE_EMAIL)("sends a rehearsal copy of the latest saved report to the approved recipient", async () => {
    const brief = await latestSavedBrief(makeSupabaseTeamStore());
    expect(brief).not.toBeNull();
    const r = await sendRehearsalEmail({ brief: brief!, nonce: String(Date.now()) });
    console.log(JSON.stringify({ week: brief!.weekStart, result: r }));
    expect(r).toMatchObject({ status: "sent" });
  });
});
