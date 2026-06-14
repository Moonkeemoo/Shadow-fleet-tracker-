# Logistics / transport layer — design

**Date:** 2026-06-14
**Status:** Approved (user). A third target layer alongside oil-infra and military-industrial — **🚆 Logistics**: Russian rail and transport/storage infrastructure that feeds the war effort (rail depots/junctions, bridges, ammunition/weapons arsenals). Mirrors the military-industrial layer pattern exactly.
**Why:** Ukrainian strikes increasingly hit logistics (rail depots like Vyazma, bridges like Chonhar, arsenals like Toropets) that fit neither oil-infra nor military-PRODUCTION. This layer captures them with the same curated/cited ethos.

## Data — `data/logistics-sites.json` (curated, every fact cited)
Same shape as `data/military-sites.json`:
```
{ "sites": [ {
  "id": "kebab-case-id",
  "name": "English name",
  "name_local": "русское/українское название" | null,
  "lat": number, "lon": number,
  "category": "rail-depot" | "rail-junction" | "bridge" | "arsenal" | "other",
  "role": "1-line what it does (e.g. 'Moscow–Minsk mainline locomotive depot')",
  "operator": "RZD / MoD / ..." | null,
  "region": "oblast/krai/occupied" | null,
  "status": "operational" | "damaged" | "destroyed" | "unknown",
  "strikes": [ { "occurred_on": "YYYY-MM-DD", "weapon": "uav"|"missile"|"sabotage"|"unknown",
                 "severity": "major"|"moderate"|"minor"|"unknown",
                 "summary": "1-2 sentences", "source_urls": ["..."] } ],
  "notes": "short note" | null,
  "source_urls": ["site-level sources"]   // >=1
} ] }
```
`struck` derived (`strikes.length>0`). Seed: Vyazma rail depot + ~10 other confirmed logistics targets (rail junctions, Chonhar/other bridges, arsenals e.g. Toropets/Tikhoretsk ammo depots) — each ≥1 site source, each strike ≥1 source, multi-source preferred.

## Pure module — `packages/api/src/logistics-normalize.ts` (+ test)
Near-identical to `military-normalize.ts`: `normalizeLogisticsSite(raw): LogisticsSite | null` (reject missing id/name, bad coords, no http(s) source_urls; category ∈ 5 values else "other"; status ∈ 4 else "unknown"; strikes normalized via the shared `toIsoDate`/`toStr`/`toCoord`/`toUrls` from infra-normalize; weapon ∈ {uav,missile,sabotage,unknown}; severity ∈ 4; drop strike if bad date or no http source; `raw` passthrough). Export `isStruck`. Unit-test mirroring military-normalize.test.ts.

## Backend
- Migration `db/migrate-add-logistics.sql` (idempotent, house header): table `logistics_sites` (id TEXT PK, name, name_local, lat REAL, lon REAL, category TEXT, role TEXT, operator TEXT, region TEXT, status TEXT, strikes JSONB, notes TEXT, source_urls TEXT[], raw JSONB, first_seen TIMESTAMPTZ DEFAULT NOW()); index on category.
- Loader `packages/api/src/cli/load-logistics.ts` (mirror load-military): parse {sites}, ensureTable, normalize, upsert ON CONFLICT (id), **sql.json** for strikes+raw. package.json script `load-logistics`. reconTables gains `logistics` flag.
- `GET /api/logistics` (cache 600_000; `?category=` pass-through like infra; graceful `{available:false}`; derived `struck` via `COALESCE(jsonb_array_length(strikes),0)>0`; ORDER BY category,id).

## UI (web/index.html)
- Chip `🚆 Logistics` after the 🎯 Military chip; `logisticsLayer` = `L.markerClusterGroup` (same clusterOpts/iconCreateFunction/status-coloring as the others — singleMarkerMode + disableClusteringAtZoom 8); `layerVisible.logistics`; toggle wiring.
- Boot `loadLogistics()` static. Markers: a muted **logistics family tint** distinct from oil (bronze) and military (steel-blue) — e.g. muted green/teal `#6f9e8a`; category shapes (rail-depot=boxcar/rect, rail-junction=crossed-tracks, bridge=arch, arsenal=shell, other=dot). Reuse the status ring (struck recency) + burning pulse + `ofStatus`/cluster system + `ofRealIcon` zoom-swap exactly as infra/military.
- Panel `openLogisticsPanel(s)`: Profile (category label, local name, role, operator, region, status, coords) → Struck? → Strike history (reuse attackEntry + chips, newest first) → Notes → Sources.
- Legend: add a logistics section/entries (category glyphs in the logistics tint + "🚆 logistics" grouping). 
- `/api/feed`: add a third UNION branch for logistics (layer 'logistics', strikes from jsonb, origin curated/verified true) so logistics strikes appear in the feed.

## Docs
methodology.html (provenance row + layer sentence: "four target layers" now) + README (feature bullet, load-logistics command, data-sources row, repo-layout entries).

## Verify
tsc 0; full test suite green (160 + new logistics-normalize tests); migration idempotent (×2); `bun run load-logistics` loads the seed; `curl /api/logistics` (+ `?category=bridge`); UI chip/markers/cluster/panel render; feed shows a logistics strike; headless no console errors.

## Out of scope (v1)
Airfields/air defense (separate); normalized logistics_strikes table (strikes stay embedded); FIRMS/Impact integration for logistics.
