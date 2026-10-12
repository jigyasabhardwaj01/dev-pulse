# JARVIS frontend redesign: implementation plan (for review)

Status: PLAN ONLY. No frontend code has been changed for this. It will be implemented on a separate branch (`frontend-redesign`),
reviewed, and deployed separately from the rebrand release (commit a3efea3, live).

## Hard boundaries (unchanged)
- No change to `src/lib/**` logic (pipeline, store, email, coverage, brief policy, sources), API routes, migrations, env vars,
  report data or the email safeguards. The redesign touches `src/app/**` pages, `src/components/**`, `globals.css` and their tests only.
- Data contracts stay as they are: the components keep consuming `ReportView`, `HistoryRow`, `RunView` from `report-model.ts`.
  A new field is added only if a design needs it, and only in the view-model layer, never in storage.
- The Pipeline page stays read-only and sanitized. The cron stays paused. No email, no backfill.
- Free tier, no new runtime dependencies (Recharts stays; no UI kit, no icon or font packages).

## What the live app does today (observed)
- Home (`/`): header with delivery pill, pager, summary card, "Read with care" box, 4 stat tiles, source chips, then the pain points
  by category, then the history chart. Light/dark follow the OS. Pages: `/history`, `/posts`, `/status`.
- 886 lines of UI code across 5 pages and 15 components; one 147-line stylesheet with design tokens.

## Problems to fix (ordered by value to the reader, a PM reading one report a week)
1. **The answer is below the fold.** The pain-point list is the product, but it starts after the summary, a 4-bullet caveat box, 4 tiles and the source chips.
2. **Caveats are noisy and repetitive.** The same Hacker News / GitHub "page limit" notice appears twice (this and previous period) as four bullets.
3. **Pain-point rows need to be scannable.** Reader should see rank, theme, mentions, change vs last week and "mostly unresolved" at a glance, with evidence one tap away.
4. **No JARVIS identity.** The wordmark still carries the generic pulse icon; palette and type are neutral defaults.
5. **Mobile.** Navigation and header stack consume the first screen; tables on `/history` and `/posts` need a card layout on narrow screens.
6. **Small defects:** a well-formed but unknown `?week=` returns 200 with a not-found body (should be a real 404); the streamed "Loading the report…" fallback is shown
   in the server HTML before content; `/status` labels are technical.

## Proposed changes
### A. Report page information hierarchy (`ReportContent`, `ReportHeader`, `StatTiles`, `DataQuality`, `SourceHealth`, `PainPointGroups`)
- New order: header (period, delivery, version, pager) → **summary** → **top movers strip** (up to 3 biggest changes, derived from the existing points) →
  **pain points by category** → data notes → sources → history chart.
- Stat tiles become one compact line of 4 figures (mentions, pain points, % unresolved, sources healthy).
- **Data notes** become one collapsed-by-default "Data notes (n)" disclosure with merged, de-duplicated items ("Hacker News and GitHub hit the page limit in both weeks"),
  but a single-line amber banner stays visible when comparison is withheld or a source failed, because that changes how to read the report.
- Pain-point row: theme, mentions, change badge, an unresolved marker and a thin proportional bar; "View the posts →" stays.

### B. Identity and visual system (`globals.css`, `layout.tsx`, `NavLinks`)
- JARVIS wordmark (text, tracked caps) with a simple inline SVG mark replacing the pulse waveform; refined accent colour and elevated surfaces, tokens kept in `:root` with light/dark parity.
- Sticky slim top bar; on mobile a bottom-aligned or compact nav so content starts higher. Focus rings, 44px touch targets, reduced-motion respected.

### C. Other pages
- `/history`: report cards (period, mentions, healthy sources, trend state, email state) instead of a wide table on mobile; chart gets a clearer legend and the existing accessible data table.
- `/posts`: filter bar that wraps cleanly on mobile; post rows as cards with source, theme, unresolved flag and date.
- `/status`: plain-language headings ("Last run", "Source health"), same sanitized content, still read-only.
- Real 404 for unknown `?week=`; consistent empty / error states.

### D. Out of scope (needs your separate decision)
Authentication/gating of `/status`, caching or ISR, a custom domain, charts beyond the existing one, any new data or metric, relevance/taxonomy work for the "other" bucket.

## Test and verification plan
- Update the component tests (`stage2-ui.test.tsx`, `branding.test.ts`) and add tests for: caveat de-duplication and the always-visible degraded banner; top-movers selection;
  row rendering for every trend state (comparable, withheld, new, no prior); the 404 for an unknown week; no raw errors on `/status`.
- Typecheck, full suite, production build. Local read-only run against the live database; screenshots at 375 / 768 / 1280, light and dark; keyboard-only pass;
  an automated contrast spot-check of the token pairs.
- Deliverable: one branch and one PR-style diff with before/after screenshots. Not deployed until you approve.

## Decisions I need from you (defaults in bold)
1. Visual direction: **clean, light-first analytical dashboard with a deep-blue accent** / darker "control room" look / keep the current palette and only restructure.
2. Mobile navigation: **compact top bar with the three links** / bottom tab bar.
3. Are the "top movers" strip and the collapsed data notes acceptable, given the notes hold caveats the report depends on?
