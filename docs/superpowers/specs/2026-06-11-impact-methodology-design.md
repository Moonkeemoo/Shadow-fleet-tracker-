# Impact methodology revamp — tempo + severity + external outage estimates

**Date:** 2026-06-11
**Status:** Approved (user). Replaces the misleading "% of nameplate capacity struck" headline.
**Why:** counting full nameplate capacity of any once-struck facility overstates impact
(reads as "60% of Russian refining down" — false). Three honest measures instead.

## A — lead with campaign tempo (our cited data; drop the % headline)
- The Impact page headline becomes **intensity**: total strikes, distinct facilities hit,
  strikes/month + facilities/month (the existing monthly chart), cumulative distinct
  facilities ever hit.
- **Remove** the "pct_capacity_struck_90d" KPI as a headline. Keep raw Σ-nameplate only as a
  small, heavily-caveated reference number if useful ("nameplate capacity of facilities ever
  touched — breadth, NOT outage"), not as a percentage and not prominent.
- No self-computed economic %. (The /api/strike-impact tile keeps its current behaviour; only
  the Impact page framing changes — and the tile's % can stay since it's caveated, but the
  page no longer leads with it.)

## C — per-strike severity (our data, cited per strike)
- Add `severity` to strike records: `minor` (tank/auxiliary/small fire), `moderate`
  (process-unit damage, partial outage), `major` (primary unit / CDU hit, large or extended
  outage), or `unknown` when the source doesn't say. Curated from each strike's own sources.
- **Migration:** `ALTER TABLE infra_strikes ADD COLUMN IF NOT EXISTS severity TEXT;` (idempotent).
  `infra-normalize.ts` accepts `severity` (one of the 4, default `unknown`); loader reads/upserts it.
- **Data:** a research pass re-tags the 256 records in `data/infra-strikes.json` with a
  `severity` field, each tag grounded in that record's existing source_urls/summary (no new
  sourcing needed — classify from what's already cited). Records the rationale only as the tag.
- **Page:** "strikes by severity over time" (stacked/grouped bars or a small breakdown) +
  a card "facilities with a major hit (N)". **UI strike-history chip:** show a severity chip
  (minor=grey, moderate=amber, major=red) on each strike entry in the infra panel.
- Honest framing: severity is a curated classification of reported damage, not a measured
  outage figure.

## B — external reported-outage estimates (economic toll, others' numbers)
- New curated, cited dataset `data/refining-outage.json`:
  `{ "estimates": [ { "as_of": "YYYY-MM-DD", "offline_kbd": number|null,
     "offline_pct": number|null, "metric": "kbd"|"pct", "source": "Reuters|Bloomberg|CREA|S&P|EnergyAspects|...",
     "source_url": "...", "note": "1-line context" } ] }`
  Each row is a point-in-time published estimate of Russian primary-refining capacity offline
  due to strikes. Compiled by a research pass (press/CREA/S&P notes), every row source-cited.
- **Migration:** `CREATE TABLE IF NOT EXISTS refining_outage ( id TEXT PRIMARY KEY,
  as_of DATE NOT NULL, offline_kbd REAL, offline_pct REAL, metric TEXT, source TEXT,
  source_url TEXT, note TEXT, raw JSONB, first_seen TIMESTAMPTZ DEFAULT NOW() );` + index on
  `as_of`. Idempotent. id = `${as_of}-${source-slug}`.
- **Loader** `packages/api/src/cli/load-refining-outage.ts` (mirror load-infra-strikes;
  sql.json; package.json script `load-refining-outage`). reconTables gains `outage` flag.
- **Page:** a line/scatter "estimated refining capacity offline over time (external estimates)"
  with each point labelled by source on hover; clearly headed "external estimates — not our
  calculation; sources cited."

## API: extend `GET /api/impact`
- Drop nothing existing (back-compat), but ADD:
  `by_severity_monthly`: [{month, minor, moderate, major, unknown}] (continuous 2022→now),
  `severity_totals`: {minor, moderate, major, unknown}, `major_facilities`: count of distinct
  facilities with ≥1 major strike, and `outage_estimates`: the refining_outage rows
  (as_of, offline_kbd, offline_pct, metric, source, source_url, note) sorted by as_of —
  graceful `[]` when the table/flag absent.
- reconTables guard extended for `outage`. Cache stays 300s.

## Page rewrite (`web/impact.html`)
Re-order to: (1) tempo cards + monthly strikes chart, (2) severity-over-time + major-hit card,
(3) external offline-estimate chart, (4) top facilities (add a severity column), (5) breakdowns.
Remove the prominent "% of capacity" card. All external-estimate values labelled with source.

## Architecture / testing
- Pure additions to infra-normalize.ts (severity) get a unit test. fillMonthlySeries reused
  for by_severity_monthly. No new heavy logic.
- Verify: tsc; `bun run test`; `bun run load-infra-strikes` (with severity) + `bun run
  load-refining-outage`; `curl /api/impact` shows by_severity_monthly + outage_estimates;
  impact.html renders the three sections; severity chips in infra strike-history.
- Docs: methodology page — explain the three measures + the explicit "we do not compute an
  economic % ourselves; offline figures are external cited estimates" statement. README bullet.

## Out of scope
Our own capacity-weighted "capacity-days lost" arithmetic (deliberately avoided — that was the
flawed approach). Repair/recovery tracking. Permalink (#4) / cron (#6) still deferred.
