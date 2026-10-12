# JARVIS: Backend Reference

Current as of the backend completion sprint. Everything here describes code in this repo; items marked *unverified* have not been run against a real database or provider.

Live site: https://dev-pulse-omega-pink.vercel.app.
Stack: Next.js (App Router) on Vercel, Supabase (Postgres), OpenRouter (Google Gemini Flash models only), Resend. Free tiers only.

## 1. What it does

Once a week it collects developer conversations (Hacker News, Stack Overflow, Reddit, GitHub Issues), classifies each post into a fixed list of themes per topic, counts mentions per theme, compares with the previous week **only when source coverage allows a fair comparison**, and saves one report version that both the dashboard and the email use.

## 2. Reporting periods

`src/lib/week.ts` `periodFor`: seven complete IST days, Friday 00:00:00.000 IST to Thursday 23:59:59.999 IST (end exclusive), ending at the most recent Friday 00:00 IST at or before the run. Example: a run on Fri 2026-10-09 06:00 IST covers 2026-10-01T18:30Z to 2026-10-08T18:30Z, key `2026-10-02`; the previous period starts 2026-09-24T18:30Z, key `2026-09-25`. Checked over 3 years of run times: no gaps, no overlaps, every key a Friday.

**The weekly cron is ACTIVE.** `vercel.json` registers exactly one entry, `GET /api/cron/weekly-digest` at `30 0 * * 5` (Fridays 00:30 UTC = 06:00 IST, six hours after the reporting window closes at Friday 00:00 IST; Vercel Hobby may start it up to an hour late, still the same IST Friday and the same report week). Vercel cron runs in UTC, sends `Authorization: Bearer $CRON_SECRET` itself, and runs only on the production deployment. It was paused between 2026-10-12 and the activation of this release; the pause is documented in git history.

Hobby cron fires anywhere within the scheduled hour. Vercel Hobby fires cron anywhere within the hour, so a run lands between 08:30 and 09:29 IST; delivery is best-effort, can be duplicated, and is never retried.

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

Migrations 003, 004 and 005 (005 pins the trigger function's search_path; additive) were applied to the live project on 2026-10-12 after a rolled-back dry run on the real database and a logical backup of all four tables. Verified afterwards: 7 tables with RLS, the trigger and four constraints present, every original row value unchanged, and 25-way concurrent create / compare-and-set / email-claim races each had exactly one winner (`scripts/verify-claim-concurrency.mjs`).

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

## 12. Sources, retries and Reddit (measured behaviour)

- **Retries (all sources).** `getJson` retries only transient trouble: timeouts, network errors, HTTP 408/425/429/5xx, and a 403 that advertises when to return (GitHub's secondary limit). At most 2 retries (500 ms, 1 s backoff); a `Retry-After` is honoured when it is 8 s or less, otherwise the failure is reported at once. 400/401/404, a plain 403 and malformed bodies are never retried. Retries and rate-limit waiting are recorded per source (diagnostic codes `SOURCE_RETRIED` / `SOURCE_THROTTLED`).
- **Reddit (root cause, found 2026-10-12).** Reddit's public `.json` search is refused with a 403 block page from server networks. The public Atom (`.rss`) search works but its allowance is about **one request per minute** (`x-ratelimit-remaining: 0`, `x-ratelimit-reset` 18-58 s). The old code made 9 requests (one per subreddit per topic) 6 s apart, so most were 429s (7 of 9 failed, 0 posts). Now: **one multi-subreddit request per topic** (`r/programming+ExperiencedDevs+devops`), requests serialised, Reddit's own reset header honoured, a bounded 125 s wait budget so Reddit cannot starve the run (topics beyond the budget fail visibly as rate limited, never as zero posts). Measured live: 3 requests, 0 failed, 32 posts, about 105 s wall-clock (before: 9 requests, 7 failed, 0 posts). The public feed returns at most 25 entries per request, so a full page is reported as capped.
- **Reddit OAuth (optional, not configured).** With `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` set, the app-only authenticated API is used instead (100 requests/minute, 100 results). Code and tests exist; it has **not** been verified against Reddit because no credentials exist. Rejected credentials are reported as `SOURCE_AUTH` and are never retried.
- **Coverage honesty.** Every adapter fetches one page per query (HN 40, Stack Overflow 30, GitHub 30, Reddit 25/100) and reports a cap from the provider's own signal (`nbHits`, `has_more`, `total_count`). A capped source is a sample of the newest results and is shown as such.

## 13. Structured diagnostics

Each run stores diagnostics (stable `code`, `severity`, `stage`, a safe message written by us, `at`, optional `remedy` and numeric `detail`) in the existing `pipeline_runs.warnings` jsonb column; older runs hold plain strings and are shown only as a count. Raw error text never reaches a diagnostic message or the public page. Codes: `SOURCE_FAILED`, `SOURCE_PARTIAL`, `SOURCE_RATE_LIMITED`, `SOURCE_AUTH`, `SOURCE_CAPPED`, `SOURCE_RETRIED`, `SOURCE_THROTTLED`, `CLASSIFY_NO_MODEL`, `CLASSIFY_WARNING`, `CLASSIFY_ABORTED`, `CLASSIFY_PENDING`, `CLASSIFY_RECOVERED`, `SUMMARY_FALLBACK`, `REPORT_SAVED`, `EMAIL_SUBMITTED`, `EMAIL_ALREADY_SENT`, `EMAIL_FAILED`, `EMAIL_OUTCOME_UNKNOWN`, `EMAIL_UNCONFIRMED`, `EMAIL_STATE_CHECK_FAILED`, `EMAIL_BRIEF_MISSING`, `EMAIL_MARK_SENT_FAILED`, `RUN_BUDGET`, `RUN_FAILED`, `MONITORING_FAILED`. `/status` derives its stage health from these (for example the Save stage is verified only by `REPORT_SAVED`).

## 14. Cron route behaviour

`GET /api/cron/weekly-digest`: 401 without the exact bearer secret (constant-time, fails closed); 400 for a bad `asOf`; **202** `{skipped:"run_in_progress"}` if a run for the same period started in the last 6 minutes and has not finished; 200 with the run's own status (`succeeded` or `partial`) otherwise; 500 with a sanitized message on failure. One structured log line per run (counts and outcomes only). Limit: two requests that arrive in the same instant can both pass the in-progress check (there is no database lock); the outcome is still one report version and one email because the report write is compare-and-set and the email claim is a single conditional UPDATE.

## 15. Environment variables (names only; values live in Vercel's protected settings)

Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (database, server-side only), `OPENROUTER_API_KEY`, optional `OPENROUTER_MODEL` (a `google/` model id; default `google/gemini-3.7-flash`), `RESEND_API_KEY`, `DIGEST_TO_EMAIL` (single recipient), `APP_URL` (dashboard link in the email), `CRON_SECRET` (cron authentication). Optional: `STACKEXCHANGE_KEY`, `GITHUB_TOKEN`, `REDDIT_USER_AGENT`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`. The Supabase tables have row-level security enabled with no policies, so the public anon/publishable key can read and write nothing (verified: every table returns an empty result and writes are rejected).

## 16. JARVIS 2.0: watchlist, classification, checkpoints, analysis

- **Watchlist** (`watch_terms`, `watchlist_settings`, `watchlist_changes`): terms are normalised (lower-case, collapsed spaces, `[a-z0-9 +#./_-]`, 2 to 80 chars). Exclusions may be topic-wide or scoped to one include term. Duplicate terms, an exclusion that would swallow a watched term, and removing or pausing a topic's last active term are refused; ambiguous words only warn. Every change is audited (actor, action, before/after). Reports keep the sealed `config_snapshot` they were built with.
- **Modes** (`classificationPolicy`): Strict (min confidence 0.7, 0.8 for ambiguous-only matches, title match or two terms, confidence required), Balanced (0.5 / 0.65), Early (0.3 / 0.45, plural variants, results under 0.5 labelled early signals). The mode also selects the instruction block in the Gemini prompt.
- **Checkpoints** (`source_checkpoints`): attempt, success and committed are separate. `committed_through` moves only after data is stored, only on an ok, uncapped fetch; 2-day overlap on resume; 24 h late-arrival grace before a gap is skipped.
- **Classification v2**: runtime-validated JSON rows, injection-neutralised post text, batching and retries, persisted failure codes, no repeated AI calls for already-classified posts.
- **Analysis** (`src/lib/analysis.ts`, model `weighted-v1`): frequency .35, change .20, persistence .15, breadth .15, unresolved .10, strength .05. A thread counts at most 1.25 discussions. Top 3 needs at least 2 discussions and a verified excerpt. The 4-week baseline is shown only when 4 comparable weeks exist. The analysis is sealed into the saved brief; the Friday email is built from that saved version.

## 17. Team workflow and security

- **Access: no login, by decision.** Everyone who opens the site can read everything and use every tool (watchlist edits, shortlist/unshortlist, votes, decisions, Monday pack, derive analysis). There are no passcodes, rosters, sessions or sign-in emails. What remains: a random per-browser visitor id cookie (`jarvis_visitor`, httpOnly) so "one vote per person" and the audit trail mean something (anonymous; it proves nothing about identity), and a same-origin + JSON check on every write (CSRF). **Consequence:** anyone with the URL can change the watchlist, record decisions and build packs; reports and delivered emails are unaffected (they are immutable and the cron route stays secret-protected). If this ever needs protecting, add authentication in front of the write endpoints (`src/lib/api-guard.ts`).
- **Writes**: every POST/PUT/PATCH/DELETE requires same-origin JSON; the actor is the visitor id cookie, never a name in the request body. Reading and writing are open to all.
- **Review**: shortlist (any member; the pain point must exist in the saved report's sealed analysis; one item per topic and theme), owner opens voting, one vote per person (changeable, withdrawable), owner decision recorded through the `record_review_decision` function (atomic: supersede, insert, state, event). Decisions are never edited or deleted (trigger); the vote tally at decision time is stored beside it but never computes the outcome.
- **Monday pack**: built by the owner on request from the latest saved report and the current decisions; committed list = prioritised decisions only; AI suggestions are labelled and separate; stale when the decisions digest changes or a newer report exists; no schedule invented.
- **Failure alerts**: scheduled runs only; run failed, email failed/unconfirmed, or every source down. One per kind and week (`alert_log` unique key), at most 3 per kind per 24 h, codes only, to `DIGEST_TO_EMAIL` from the approved sender. An alert error never fails the run.
- **Migrations** (additive, applied in order): 006 JARVIS 2.0 tables and columns, 007 checkpoint range, 008 `record_review_decision`. Recovery notes are at the top of each file; nothing existing is altered.
- **No new env vars for access.** `SESSION_SECRET`, `OWNER_PASSCODE`, `TEAM_PASSCODE`, `JARVIS_OWNER_EMAIL` and `JARVIS_TEAM_EMAILS` are not read by the application (any copies left in Vercel can be deleted).

## 18. AI inference: OpenRouter, Google models only

- Every AI call (classification and the Friday summary) goes through `src/lib/openrouter.ts`: `POST https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer $OPENROUTER_API_KEY`. There is no direct Google call path any more.
- Model: `OPENROUTER_MODEL`, default `google/gemini-3.7-flash`. Only plain `google/<model>` ids are accepted (no other vendor, no `:nitro`/`:floor` variants). Verified present in `GET /api/v1/models` on 2026-10-12 with endpoints on Google AI Studio and Google Vertex.
- Routing: `provider: { order: ["google-ai-studio","google-vertex"], only: [same], allow_fallbacks: false, require_parameters: true }`. If Google cannot serve a request (HTTP 404 "no endpoints"), the call fails; it is never relaxed to another vendor. A response whose model or provider is not Google is discarded.
- Retries: at most 3 attempts for 408/429/5xx/network errors with back-off (Retry-After honoured, capped, and never past the run's deadline). 401/403 (bad key) and 402 (no credit) stop immediately and trip a breaker so the rest of the run makes no further requests; the run then reports `CLASSIFY_ABORTED` and the posts stay unclassified for the next run.
- Usage (model, provider, latency, tokens, cost when OpenRouter returns it) is available per call through `onResult`.
- Live check: `LIVE_AI=1 OPENROUTER_API_KEY=... npx vitest run tests/live-openrouter.dev.test.ts`. The key must be a rotated one set in Vercel's protected settings; never commit it.

## 19. Active sources and the Reddit decision (2026-10-12)

Evidence from production runs (`source_fetches`): Hacker News, GitHub Issues and Stack Exchange answered every request (0 failures). Reddit's public feed, requested from Vercel, was answered with HTTP 429 (once 403) in 8 of 9 topic fetches across two runs, taking 18 to 54 s each, while the same feed answered from a developer machine. That points at rate limiting of shared hosting IPs, not at our request construction or parsing. Without API credentials there is no supported way to make it reliable, so:

- **Active by default:** Hacker News, Stack Exchange (Stack Overflow site), GitHub Issues.
- **Reddit is opt-in:** collected only when `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` (app-only OAuth) are set, or when `REDDIT_PUBLIC_ENABLED=1`. Otherwise the run records `SOURCE_DISABLED`, the report's `coverage.notCollected` names Reddit and the reason, the report page shows a "Not collected" row and a warning note, the sealed analysis and the Friday email carry a limitation line, and Pipeline Health shows Reddit as "Not checked". It is never shown as zero posts or as a failure.
- **Comparison:** a source switched off on purpose does not block week-over-week trends when it supplied under 10% of the previous period's posts (a caveat is shown); above that, trends are withheld.
- **Coverage lost:** Reddit supplied about 1.5% of stored posts (6 of 395), so the practical loss is small. Stack Exchange yields little for these topics (0 to 6 posts per topic per week) but works.
- No other source was added: no further documented, reliable, free source was justified for the current topics.
