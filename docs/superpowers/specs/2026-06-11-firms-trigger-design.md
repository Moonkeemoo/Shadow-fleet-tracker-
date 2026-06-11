# FIRMS-triggered strike detection — Design

**Date:** 2026-06-11
**Status:** Approved (user's architecture insight).
**Thesis (user):** stop polling all 69 facilities through news APIs (rate-bans, noise).
Instead let the satellite point us: a fresh thermal anomaly at a facility *triggers* a
targeted check of that one object for strike news → a candidate the curator confirms.

## Why this works (and solves the rate-ban)
- FIRMS is one cheap reliable call (whole-RU, free, near-real-time). It already yields
  ~15 "active" facilities (`fires-match` conservative flag).
- We run a GDELT lookup ONLY for those ~15 active facilities that have no known recent
  strike — a handful of queries, not 69 → no IP ban (the ban came from bulk polling).
- The two signals compose: **satellite heat** says *where to look*; **targeted news**
  confirms it's a *strike*, not routine flaring. A facility that flares daily (Ufa) but
  has no strike news yields no candidate — the news query self-filters. So we get a
  reliable candidate WITHOUT needing a per-facility flare baseline.

## v1 (this feature) — no baseline required
CLI `bun run load-firms-triggered [timespanDays=3]` (`packages/api/src/cli/load-firms-triggered.ts`):
1. Fetch FIRMS (reuse the `/api/fires` regional-bbox + parse logic; factor the fetch/parse
   into a shared helper if clean, else duplicate minimally), match to facilities
   (`matchFiresToFacilities`, 3 km) → active facilities.
2. For each active facility with NO existing `infra_strikes` row within ±2 days of an
   anomaly date: run ONE targeted GDELT query (reuse `gdelt-match`:
   `buildGdeltQuery(name, name_local)`, `isStrikeArticle`, `mapGdeltArticle`), last
   `timespanDays`. 7.5 s pacing + the existing 429 circuit breaker. Expected ≤15 queries.
3. Strike-articles found → upsert a candidate into `infra_strikes`:
   `origin='firms-trigger'`, `verified=FALSE`, `weapon` from article, summary =
   article title + " [auto: FIRMS→GDELT]", `source_urls` = [article url],
   `raw` = { firms: {count,max_frp,last_date}, article } via `sql.json`. Skip if a curated
   row already exists for that facility ±1 day.
4. No FIRMS key or no GDELT reachable → log + exit 0 (graceful, like the other loaders).

`verify-strike` already accepts non-curated origins — extend its guard to include
`firms-trigger` (currently `acled`/`gdelt`).

## UI
`firms-trigger` candidates already render via the unverified-chip path. Add a distinct
chip on those entries: `🔥🛰 heat-triggered` (origin === 'firms-trigger') alongside the
existing `auto · unverified` chip, so the curator sees these came from the satellite
trigger. The `/api/infra-strikes` SELECT already returns `origin` — no API change needed.

## Out of scope (v2 — baseline refinement)
- Persisting daily per-facility FIRMS aggregates (`firms_daily` table) to learn each
  facility's flare baseline, so the trigger fires on *above-normal* heat rather than the
  conservative active flag. Needs weeks of snapshots to be meaningful; documented as the
  next iteration. v1's news-self-filtering already prevents flare-only false candidates.
- Auto-status flips on facilities; digest integration.

## Honesty / methodology
firms-trigger candidates are exactly that — candidates from satellite-heat + a news hit,
unconfirmed until a curator runs `verify-strike`. Methodology + README get a short note
and the loader command.
