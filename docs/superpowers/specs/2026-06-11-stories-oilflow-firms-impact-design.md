# Three "story" features — Oil-flow chain, FIRMS fire detector, Impact metric

**Date:** 2026-06-11
**Status:** Approved direction (user).
**Thesis:** make OilFront's data *tell stories on the surface* — no separate "Stories"
page. Every story is reachable by clicking a point on the existing map or reading a
header tile. Three independent features, built and merged separately.

---

## Feature 3 — Impact metric (header tile)  [smallest, build first]

A new stat tile in the existing header stat row (next to sanctioned / STS / refresh):

> **🔥 Refining hit** — `N facilities struck (90d) · X Mt/yr` and, when FIRMS is wired,
> `· M burning now`.

- **Endpoint `GET /api/strike-impact`** (cache 300 s): from `infra_strikes` ⋈ `oil_infra`
  returns: `struck_30d`, `struck_90d` (distinct facility counts), `capacity_struck_90d_mt_yr`
  (Σ capacity_mt_yr of refineries struck in 90d), `total_refining_capacity_mt_yr`,
  `pct_capacity_struck_90d`, `strikes_30d`/`strikes_90d` (event counts). Graceful empty when
  tables absent.
- **`burning_now`** comes from `/api/fires` (Feature 2) and is merged client-side, so the
  tile works before FIRMS lands.
- **UI:** tile in `web/index.html` header; tooltip carries the honest caveat — *"struck ≠
  fully offline; capacity figures are nameplate, not live throughput."* Click optional →
  reuse the existing panel to list the struck facilities (nice-to-have, can defer).
- **Honesty:** % is "share of *mapped* refining capacity struck in 90 days", not "% of
  Russian refining offline". Label says exactly that.

---

## Feature 2 — FIRMS fire detector  [medium; reshaped per user — detector, not passive layer]

NASA FIRMS thermal anomalies, used to **update facility state directly** and corroborate
strikes — satellite heat is locationally trustworthy where news geocoding is not.

### Data (verified live 2026-06-11)
`GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/{FIRMS_MAP_KEY}/{SOURCE}/{W,S,E,N}/{dayRange}`
— `dayRange` max **5**; CSV cols `latitude, longitude, bright_ti4, scan, track, acq_date,
acq_time, satellite, instrument, confidence (l|n|h), version, bright_ti5, frp, daynight`.
Sources: `VIIRS_NOAA20_NRT` + `VIIRS_SNPP_NRT` (375 m, merged). Key in `.env`
`FIRMS_MAP_KEY` (already added; gitignored). No key → everything degrades to empty.

### Server `GET /api/fires` (cache 3600 s, no DB)
Fetches a handful of regional bboxes covering our facilities (European RU, Volga/Urals,
W-Siberia, Far East, Caucasus/Caspian — ~5 requests, not 81), merges, dedups, returns:
```
{ points: [{lat, lon, frp, confidence, acq_date, daynight}],   // for the toggle layer
  facilities: { <infra_id>: {count, max_frp, max_confidence, last_date} } }  // matched
```

### Pure matcher `packages/api/src/fires-match.ts` (unit-tested, no network)
`matchFiresToFacilities(points, facilities, radiusKm=3)` → per-facility aggregate of
points within radius (haversine reuse). **Conservative auto-flag** `active` = at least one
`h`/`n`-confidence detection AND (≥2 detections OR max_frp ≥ threshold) — to suppress
single agricultural/flare pixels.

### Cross-verification (the payoff)
A strike (curated/acled/gdelt) with a matched FIRMS anomaly at the same facility within
±1 day → strike entry shows **🛰 satellite-corroborated**. A facility with an `active`
anomaly and **no** known strike → profile shows **🔥 active thermal anomaly** (curator lead —
"possible unreported strike"). Both are display-time joins from `/api/fires`; no writes
to `infra_strikes` in v1 (keeps the curated dataset clean; curator promotes via the
existing `verify-strike` flow if they confirm).

### UI
- Chip **🔥 Fires** (next to Infra/Attacks) → `firesLayer` of thermal points (small
  orange dots, opacity by FRP).
- `loadInfra` cross-references `/api/fires` `facilities`: an `active` facility gets a 🔥
  badge on its marker + a profile row "active thermal anomaly · N detections (Xd), may
  include routine flaring".
- Strike-history entries gain the 🛰 corroboration chip when matched.

---

## Feature 1 — Oil-flow supply chain  [largest; on-demand from any point]

Click any entity → a **🛢️ Supply chain** section reveals the tanker↔terminal↔pipeline↔
refinery linkage, bidirectionally, with map highlight of the chain.

### Curated links `data/infra-links.json` (research pass, every link cited)
The terminal↔pipeline↔refinery relationship is curated, not geometry-guessed (a pipeline
passing near a refinery ≠ feeding it). Shape:
```
{ "links": [ { "pipeline_id": "<oil_infra id>", "terminal_id": "<oil_infra id>",
               "refinery_ids": ["<oil_infra id>", ...], "commodity": "crude|products",
               "source_urls": ["..."] } ] }
```
Well-documented set (~10–12): Druzhba, BTS-1→Primorsk, BTS-2→Ust-Luga, ESPO→Kozmino,
CPC→Novorossiysk/Yuzhnaya Ozereyevka, Baku–Novorossiysk, Sever→Primorsk, etc. Plus this
pass adds a `locode` to export-terminal records in `oil-infra.json` (curated) so a tanker's
decoded `destination` LOCODE matches a terminal directly.

### Backend
- Migration `db/migrate-add-infra-links.sql` + loader `load-infra-links.ts` →
  `infra_links` table (pipeline_id, terminal_id, refinery_ids BIGINT? no — TEXT[], commodity,
  source_urls, raw). Loader uses `sql.json` for raw (never stringify+::jsonb). package.json
  script. reconTables gains `links` flag.
- `GET /api/infra/:id/chain` — given any infra id, returns the connected chain
  (terminal→pipeline→refineries[] and back), each node `{id, kind, name, lat, lon}`,
  graceful empty when no link / table absent.
- Vessel detail (`handleVesselDetail`): if the vessel's decoded destination LOCODE matches
  a terminal with links, response gains `supply_chain` (terminal→pipeline→refineries).

### UI
- **Vessel panel:** "🛢️ Supply chain" section when `supply_chain` present — terminal →
  pipeline → refineries, each a clickable chip (fly-to + open that infra panel).
- **Infra panel:** new "🛢️ Supply chain" section via `/api/infra/:id/chain` — refinery shows
  downstream (pipeline→terminal); terminal shows upstream (pipeline→refineries); pipeline
  shows both ends.
- **Map highlight:** clicking the chain draws a highlighted poly-connection (dedicated
  `chainLayer`, cleared on panel close) linking the nodes so the route is visible.

---

## Architecture / cross-cutting
- All three follow existing patterns: chips+LayerGroups, panel `.section` blocks,
  `reconTables()` graceful-degradation guard, in-memory response cache, pure unit-tested
  matchers (`fires-match.ts` joins the existing `acled-match`/`gdelt-match` family).
- JSONB always via `sql.json` (repo trap: stringify+::jsonb stores a string scalar).
- Build order: Feature 3 → Feature 2 → Feature 1 (each its own branch, reviewed, merged).
- Each new external dependency (FIRMS) degrades silently without its key.

## Out of scope (v1)
- FIRMS persistence/baseline modeling (per-facility flare baseline) — v1 uses confidence +
  multi-pixel + FRP heuristics with an honest "may include flaring" caveat.
- Writing FIRMS anomalies into `infra_strikes` automatically — display-time corroboration
  only; curator confirms via existing flow.
- Tanker→terminal historical "who called here" lists on the terminal card — chain is
  pipeline/refinery side first; AIS port-call backfill can be a later iteration.
- A separate scrollytelling "Stories" page (explicitly rejected — stories live in-place).
