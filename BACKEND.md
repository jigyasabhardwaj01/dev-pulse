# JARVIS: Backend Reference

Current as of the backend completion sprint. Everything here describes code in this repo; items marked *unverified* have not been run against a real database or provider.

Live site: https://dev-pulse-omega-pink.vercel.app.
Stack: Next.js (App Router) on Vercel, Supabase (Postgres), Gemini Flash, Resend. Free tiers only.

## 1. What it does

Once a week it collects developer conversations (Hacker News, Stack Overflow, Reddit, GitHub Issues), classifies each post into a fixed list of themes per topic, counts mentions per theme, compares with the previous week **only when source coverage allows a fair comparison**, and saves one report version that both the dashboard and the email use.

## 2. Reporting periods

`src/lib/week.ts` `periodFor`: seven complete IST days, Friday 00:00:00.000 IST to Thursday 23:59:59.999 IST (end exclusive), ending at the most recent Friday 00:00 IST at or before the run. Example: a run on Fri 2026-10-09 09:00 IST covers 2026-10-01T18:30Z to 2026-10-08T18:30Z, key `2026-10-02`; the previous period starts 2026-09-24T18:30Z, key `2026-09-25`. Checked over 3 years of run times: no gaps, no overlaps, every key a Friday.

**Weekly cron is currently PAUSED** (`vercel.json` has `"crons": []`, since 2026-10-12, pending the first verified delivery). To resume, restore `{ "crons": [{ "path": "/api/cron/weekly-digest", "schedule": "30 3 * * 5" }] }` and redeploy. The route itself stays available; without the cron, nothing runs it unless someone calls it with the bearer token.

Schedule when active: `vercel.json` cron `30 3 * * 5`. Vercel Hobby fires cron anywhere within the hour, so a run lands between 08:30 and 09:29 IST; delivery is best-effort, can be duplicated, and is never retried.

### `asOf` backfills (`src/lib/run-plan.ts`)
`?asOf=YYYY-MM-DD` is an IST date. Rejected with HTTP 400: wrong format, impossible dates (Feb 30, non-leap Feb 29, month 13), dates after today (IST), dates before 2020-01-01, and a repeated parameter. A valid asOf is a **backfill**: it never emails and never touches delivery state.

## 3. Pipeline (`src/lib/pipeline.ts`, `runDigest`)

1. Auth: constant-time bearer check; fails closed if `CRON_SECRET` is unset.
2. Topics in a fixed order (`created_at`, then `id`), so an overlapping match is always assigned to the same topic.
3. Fetch every (topic, source) independently. An adapter reports requests/failed/errors/truncated; a failure is never a silent empty result.
4. Keep posts inside the period that match the topic's keywords; dedupe on `(source, source_id)`; insert.
5. **Classify** the current period first, then earlier periods inside an 84-day lookback. Each validated batch is saved immediately. A record is accepted only if well-formed; a missing/blank theme or (for non-Stack-Overflow sources) a missing `unresolved` flag stays retryable and is never stored as "other". Themes outside the closed vocabulary are stored as "other".
6. **Reconcile earlier reported periods** with late-classified posts (`growOnly`: counts can only increase, never decrease or disappear).
7. Aggregate the period; assess comparability (section 4); save aggregates and the period's coverage.
8. **Saved report** (section 5), then email (section 6).
9. A time budget (270 s planned of Vercel's 300 s) stops new classification batches in time to finish; the rest is retried next run.
10. Run and per-source health are recorded; a monitoring failure never masks a pipeline error.

## 4. Comparing weeks (`src/lib/coverage.ts`)

Per period, each source has a status (`ok`/`partial`/`error`), a post count, and a `truncated` flag. A comparison is:
- `no_prior`: no earlier report recorded on the same IST convention (legacy weeks are never used as a baseline);
- `incomparable`: a source tracked in only one period, a source whose status differs between periods, or a material source (>=10% of posts) present in only one. Trend direction and percentage are withheld; counts are kept;
- `comparable`: trend maths unchanged (`trend.ts`). Non-blocking **caveats** may still apply: results hit a page cap, or a source's share moved by >=30 points.

A source that failed identically in both periods does not make a comparison unfair. The narrative obeys the same state (it is not told about movers or new items unless the comparison is fair).

## 5. Saved report policy (`src/lib/brief-policy.ts`, `store.saveBrief`)

One row per period in `briefs` holds the version everything else uses: narrative, pain points, coverage snapshot, `pending_count`, `used_fallback`, `version`.
- A delivered or being-delivered report is **frozen**; reruns do not change it (the model isn't even called).
- A rerun never replaces a report with one that is **less complete** (more unclassified posts) or that would swap an AI narrative for the fallback.
- Identical content is a no-op (no version bump). Otherwise the version increments.
- Writes are compare-and-set on `version` and on "not delivered", so racing writers cannot overwrite each other.
- Late data still updates the **aggregates** (history charts) but not a delivered brief; that is intended and documented, not hidden.
- `email_*` columns are never part of a content write, so delivery metadata is preserved.

## 6. Email (`src/lib/email.ts`, `deliverOnce`)

The email is built from the saved version, so the dashboard and the email are the same report. Delivery is claimed with one atomic conditional `UPDATE` on `briefs`. The `Idempotency-Key` is `dev-pulse-brief-<week>-v<version>`; Resend remembers a key for 24 h and then returns the original response instead of sending again.

- **Unknown outcome** (timeout after 20 s, network error, 5xx, 409): retried up to 3 times with the same key (1 s, 4 s backoff). If still unknown, the claim stays `sending`; it is NOT marked failed, because the message may have been accepted. The run reports `unconfirmed`.
- **Definite rejection** (other 4xx): marked `failed`; the next run retries.
- **Recording "sent"** is retried 3 times (0.5 s, 1.5 s). It throws if no `sending` row matched, so a lost claim never looks like success. If it still fails the claim stays `sending`.
- **A `sending` claim** may be retaken only when it is older than the 15-minute lease **and** younger than 23 hours (inside the provider's 24 h key memory, 1 h margin). Older than that it is never retaken: the week is reported `unconfirmed` and nothing is sent.

### Unconfirmed delivery (a person decides)
The weekly run happens 7 days after any stuck claim, which is past the key window, so a stuck week is deliberately not resent automatically. Check the inbox for that week's email. If it arrived, record it:
`update briefs set email_status='sent', email_sent_at=now(), emailed_version=version where week_start='<week>';` If it did not, release it: `update briefs set email_status='failed' where week_start='<week>';` and rerun the week. (The trigger allows both, because the row is `sending`, not `sent`.)

**Remaining risk.** Not exactly-once: a duplicate now needs a person to resend by hand, or a retry inside the 23 h window whose first attempt was accepted by Resend but whose idempotent replay Resend fails to honour (documented behaviour, not verified live). A weekly email can also be missed (reported as `unconfirmed`/`failed`, never silent).

## 7. Data model and migrations

`supabase/schema.sql` is the full current schema for fresh installs. For an existing database apply, in order:
1. `migrations_002_sources.sql` (already applied to the live project),
2. `migrations_003_reliability.sql`: email columns on `briefs`; `pipeline_runs`, `source_fetches`, `report_periods`,
3. `migrations_004_report_integrity.sql`: report-version columns; a trigger that makes a delivered/being-delivered brief immutable (content, delivery record, and it cannot be deleted) and `sent` terminal; consistency constraints scoped to their own tables.

Migrations 003 and 004 were applied to the live project on 2026-10-12 after a rolled-back dry run on the real database and a logical backup of all four tables. Verified afterwards: 7 tables with RLS, the trigger and four constraints present, every original row value unchanged, and 25-way concurrent create / compare-and-set / email-claim races each had exactly one winner (`scripts/verify-claim-concurrency.mjs`).

## 8. Frontend (read-only)

`/` report (also `?week=`), `/history` report archive + chart, `/posts` evidence with filters, `/status` pipeline health. Every page tolerates the migrations not being applied yet. Trend arrows appear only for a `comparable` report; legacy, first-report and incomparable reports show counts and the reason instead.

## 9. Tests

`npm test` (vitest, no network) and `npm run typecheck`. Coverage includes: period boundaries, `asOf` validation and the route handler, classification recovery across periods, malformed-result retry, saved-report policy and compare-and-set, email request/idempotency, comparability, view-model and page rendering, a four-week lifecycle smoke test, and mutation checks that the key behaviours are actually guarded. In-memory stores mirror the SQL semantics; they do not prove database behaviour.

## 10. Deployment order

1. Apply `migrations_003` then `migrations_004` (additive; safe for the currently deployed code). **Done on the live project.**
2. Deploy the code. (Deploying first would fail scheduled runs on missing tables; the email guard fails closed.)
3. Backfill recent Fridays with `?asOf=` to seed a baseline.
4. Run once without `asOf`; it emails once. Then wait for the first real Friday.

## 11. Known limitations

- Page caps (GitHub 30, HN 40 per query, Stack Overflow 30, Reddit 25) are detected from each API's own signal (`total_count`, `nbHits`, `has_more`) and shown as caveats, not paged. GitHub reports ~75,000 matching issues per week for the seeded keywords but only the newest 30 are retrieved.
- Reddit returns nothing reliably without OAuth; it is reported as failed, not zero.
- Posts older than the 84-day lookback that were never classified are not retried.
- A function killed mid-run leaves its run row as `running` (the Pipeline page flags it).
- A permanently malformed post is retried every run until it leaves the lookback.
