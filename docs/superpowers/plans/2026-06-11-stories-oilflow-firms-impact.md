# Three Story Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface OilFront's data as in-place stories — a header impact tile, a FIRMS satellite fire-detector that corroborates strikes, and a click-anywhere oil-flow supply chain.

**Architecture:** Three independent features, each its own branch off `main`, reviewed and merged before the next. All follow existing patterns: pure unit-tested matchers (joining `acled-match`/`gdelt-match`), `reconTables()` graceful-degradation guard, in-memory response cache, chips+LayerGroups, panel `.section` blocks. JSONB always via `sql.json` (repo trap: `JSON.stringify(x)::jsonb` stores a string scalar).

**Tech Stack:** Bun, postgres-js, TimescaleDB/Postgres 16, Leaflet 1.9.4, vanilla JS, node:test.

**Spec:** `docs/superpowers/specs/2026-06-11-stories-oilflow-firms-impact-design.md`

**Build order:** Feature 3 (impact) → Feature 2 (FIRMS) → Feature 1 (oil-flow). Each on its own branch `feat/impact-metric`, `feat/firms-fires`, `feat/oil-flow-chain`.

**Reference patterns to read before each feature:**
- API handler + route + cache: `packages/api/src/server.ts` (handleInfraStrikes ~1860, route chain ~1875, withCache ~68, reconTables ~104, maybeCsvOrJson ~91, haversine in zones.ts).
- Header stat tiles: `web/index.html` header (~38-104, ids like `stat-sts`, `stat-refresh`); a stat is set via `document.getElementById(...).textContent`.
- Chips + LayerGroup + loader + boot: `web/index.html` (chips ~920, layers ~980, `loadInfra` ~1278, boot ~2240).
- Pure matcher + test: `packages/api/src/gdelt-match.ts` + `.test.ts`, `acled-match.ts`.
- Loader: `packages/api/src/cli/load-infra-strikes.ts`.

---

## FEATURE 3 — Impact metric (branch `feat/impact-metric`)

**File structure:**
- Modify `packages/api/src/server.ts` — `handleStrikeImpact()` + route `/api/strike-impact`.
- Modify `web/index.html` — header tile + fetch in boot.

### Task 3.1: `/api/strike-impact` endpoint

**Files:** Modify `packages/api/src/server.ts`

- [ ] **Step 1: Add the handler** after `handleInfraStrikes` (~line 1900). reconTables already exposes `infra` and `strikes`.

```typescript
// Aggregate strike impact on mapped refining capacity. Honest framing: this is
// the share of MAPPED refining capacity struck in a window, NOT % of Russian
// refining offline (struck ≠ fully offline).
async function handleStrikeImpact(): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const recon = await reconTables();
  if (!recon.infra || !recon.strikes) {
    return jsonResponse({ available: false, struck_30d: 0, struck_90d: 0, strikes_30d: 0, strikes_90d: 0, capacity_struck_90d_mt_yr: 0, total_refining_capacity_mt_yr: 0, pct_capacity_struck_90d: 0 });
  }
  const rows = await sql`
    WITH struck AS (
      SELECT DISTINCT infra_id, occurred_on FROM infra_strikes
    ),
    refinery_total AS (
      SELECT COALESCE(SUM(capacity_mt_yr), 0) AS total
      FROM oil_infra WHERE kind = 'refinery' AND capacity_mt_yr IS NOT NULL
    ),
    struck90 AS (
      SELECT DISTINCT s.infra_id FROM infra_strikes s
      WHERE s.occurred_on >= CURRENT_DATE - 90
    ),
    cap90 AS (
      SELECT COALESCE(SUM(o.capacity_mt_yr), 0) AS cap
      FROM oil_infra o JOIN struck90 k ON o.id = k.infra_id
      WHERE o.kind = 'refinery' AND o.capacity_mt_yr IS NOT NULL
    )
    SELECT
      (SELECT COUNT(DISTINCT infra_id) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 30) AS struck_30d,
      (SELECT COUNT(DISTINCT infra_id) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 90) AS struck_90d,
      (SELECT COUNT(*) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 30) AS strikes_30d,
      (SELECT COUNT(*) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 90) AS strikes_90d,
      (SELECT cap FROM cap90) AS capacity_struck_90d_mt_yr,
      (SELECT total FROM refinery_total) AS total_refining_capacity_mt_yr
  `;
  const r = rows[0] ?? {};
  const cap = Number(r.capacity_struck_90d_mt_yr ?? 0);
  const total = Number(r.total_refining_capacity_mt_yr ?? 0);
  return jsonResponse({
    available: true,
    struck_30d: Number(r.struck_30d ?? 0),
    struck_90d: Number(r.struck_90d ?? 0),
    strikes_30d: Number(r.strikes_30d ?? 0),
    strikes_90d: Number(r.strikes_90d ?? 0),
    capacity_struck_90d_mt_yr: Math.round(cap * 10) / 10,
    total_refining_capacity_mt_yr: Math.round(total * 10) / 10,
    pct_capacity_struck_90d: total > 0 ? Math.round((cap / total) * 1000) / 10 : 0,
  });
}
```

- [ ] **Step 2: Register the route** after the `/api/infra-strikes` line in the fetch chain:

```typescript
      if (url.pathname === "/api/strike-impact")     return await withCache(req, 300_000, () => handleStrikeImpact());
```

- [ ] **Step 3: Verify** — `bunx tsc --noEmit` clean; start server (`bun run serve`, kill old PID on :3000 first); `curl -s http://localhost:3000/api/strike-impact` → `available:true`, `struck_90d` > 0, `pct_capacity_struck_90d` a sensible number. Report values.

- [ ] **Step 4: Commit** `git add packages/api/src/server.ts && git commit -m "feat(api): /api/strike-impact aggregate"`

### Task 3.2: Header tile

**Files:** Modify `web/index.html`

- [ ] **Step 1: Add the tile** in the header stat row (read the existing stat-tile markup ~lines 880-897 and match it exactly). Add a tile with id `stat-impact`, label "Refining hit", value `—`.

- [ ] **Step 2: Add loader + boot wiring.** Add near other loaders:

```javascript
    async function loadImpact() {
      try {
        const res = await fetch("/api/strike-impact");
        const d = await res.json();
        const el = document.getElementById("stat-impact");
        if (!el) return;
        if (!d.available) { el.textContent = "—"; return; }
        let txt = `${d.struck_90d} hit / 90d · ${d.pct_capacity_struck_90d}%`;
        if (typeof window.__burningNow === "number" && window.__burningNow > 0) txt += ` · ${window.__burningNow}🔥`;
        el.textContent = txt;
        const tile = el.closest(".stat") || el.parentElement;
        if (tile) tile.title = `${d.struck_90d} mapped facilities struck in 90 days (${d.capacity_struck_90d_mt_yr} Mt/yr = ${d.pct_capacity_struck_90d}% of mapped refining capacity). Struck ≠ fully offline; capacities are nameplate, not live throughput.`;
      } catch (err) { console.error("loadImpact failed", err); }
    }
```

Call `loadImpact()` in the boot block and `setInterval(loadImpact, 300000)`. (`window.__burningNow` is set later by Feature 2's `loadFires`; until then the `🔥` suffix simply never appears.)

- [ ] **Step 2.5: Verify** — extract inline script + `node --check`; load page headless on :3000, confirm tile renders a real value, no console errors.

- [ ] **Step 3: Commit** `git add web/index.html && git commit -m "feat(ux): refining-impact header tile"`

### Task 3.3: Merge

- [ ] Spec+quality review of the branch; fix; then `git checkout main && git merge feat/impact-metric --no-edit && bun run test && git push && git branch -d feat/impact-metric && git push origin --delete feat/impact-metric`.

---

## FEATURE 2 — FIRMS fire detector (branch `feat/firms-fires`)

**File structure:**
- Create `packages/api/src/fires-match.ts` + `.test.ts` — pure matcher.
- Modify `packages/api/src/env.ts` — optional `FIRMS_MAP_KEY` (+ `.env.example`).
- Modify `packages/api/src/server.ts` — `handleFires()` + route `/api/fires`.
- Modify `web/index.html` — Fires chip+layer, loadFires, facility 🔥 badge + profile row, 🛰 strike corroboration, set `window.__burningNow`.

### Task 2.1: Pure matcher `fires-match.ts` (TDD)

**Files:** Create `packages/api/src/fires-match.ts`, `packages/api/src/fires-match.test.ts`

- [ ] **Step 1: Tests first** (node:test + assert/strict). Interfaces + behavior:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFiresToFacilities, type FirePoint, type FacilityPoint } from "./fires-match.ts";

const FAC: FacilityPoint[] = [
  { id: "ryazan-refinery", lat: 54.56, lon: 39.79 },
  { id: "tuapse-refinery", lat: 44.10, lon: 39.07 },
];
function fp(lat: number, lon: number, conf: string, frp: number, date = "2026-06-10"): FirePoint {
  return { lat, lon, confidence: conf, frp, acq_date: date, daynight: "D" };
}

test("point within radius attaches to nearest facility", () => {
  const m = matchFiresToFacilities([fp(54.561, 39.791, "h", 12)], FAC, 3);
  assert.equal(m["ryazan-refinery"].count, 1);
  assert.equal(m["tuapse-refinery"], undefined);
});
test("point beyond radius is dropped", () => {
  const m = matchFiresToFacilities([fp(55.5, 40.5, "h", 12)], FAC, 3);
  assert.deepEqual(m, {});
});
test("aggregates count, max_frp, max_confidence, last_date", () => {
  const m = matchFiresToFacilities([fp(54.56, 39.79, "n", 5, "2026-06-08"), fp(54.561, 39.79, "h", 30, "2026-06-10")], FAC, 3);
  const a = m["ryazan-refinery"];
  assert.equal(a.count, 2); assert.equal(a.max_frp, 30); assert.equal(a.max_confidence, "h"); assert.equal(a.last_date, "2026-06-10");
});
test("active flag: single low-confidence pixel is NOT active", () => {
  const m = matchFiresToFacilities([fp(54.56, 39.79, "l", 2)], FAC, 3);
  assert.equal(m["ryazan-refinery"].active, false);
});
test("active flag: two nominal+ detections IS active", () => {
  const m = matchFiresToFacilities([fp(54.56, 39.79, "n", 4), fp(54.561, 39.79, "n", 4)], FAC, 3);
  assert.equal(m["ryazan-refinery"].active, true);
});
test("active flag: single high-FRP high-confidence detection IS active", () => {
  const m = matchFiresToFacilities([fp(54.56, 39.79, "h", 50)], FAC, 3);
  assert.equal(m["ryazan-refinery"].active, true);
});
```

- [ ] **Step 2: Run red** — `node --test packages/api/src/fires-match.test.ts` → fail (module missing).

- [ ] **Step 3: Implement** `fires-match.ts`:

```typescript
// Pure matcher: NASA FIRMS thermal anomalies → per-facility aggregates.
// Conservative "active" flag suppresses single agricultural/flare pixels.
// No network. Reuses haversineNm from zones.ts.
import { haversineNm } from "./zones.ts";

export interface FirePoint { lat: number; lon: number; confidence: string; frp: number; acq_date: string; daynight: string; }
export interface FacilityPoint { id: string; lat: number; lon: number; }
export interface FireAggregate { count: number; max_frp: number; max_confidence: string; last_date: string; active: boolean; }

const NM_TO_KM = 1.852;
const CONF_RANK: Record<string, number> = { l: 0, n: 1, h: 2 };
const ACTIVE_FRP_THRESHOLD = 20;

export function matchFiresToFacilities(points: FirePoint[], facilities: FacilityPoint[], radiusKm = 3): Record<string, FireAggregate> {
  const out: Record<string, FireAggregate> = {};
  for (const p of points) {
    let best: FacilityPoint | null = null;
    let bestKm = Infinity;
    for (const f of facilities) {
      const km = haversineNm(p.lat, p.lon, f.lat, f.lon) * NM_TO_KM;
      if (km <= radiusKm && km < bestKm) { bestKm = km; best = f; }
    }
    if (!best) continue;
    const cur = out[best.id] ?? { count: 0, max_frp: 0, max_confidence: "l", last_date: "", active: false };
    cur.count += 1;
    if (p.frp > cur.max_frp) cur.max_frp = p.frp;
    if ((CONF_RANK[p.confidence] ?? 0) > (CONF_RANK[cur.max_confidence] ?? 0)) cur.max_confidence = p.confidence;
    if (p.acq_date > cur.last_date) cur.last_date = p.acq_date;
    out[best.id] = cur;
  }
  for (const id of Object.keys(out)) {
    const a = out[id]!;
    const goodConf = (CONF_RANK[a.max_confidence] ?? 0) >= 1; // nominal or high
    a.active = goodConf && (a.count >= 2 || a.max_frp >= ACTIVE_FRP_THRESHOLD);
  }
  return out;
}
```

- [ ] **Step 4: Run green** — file tests pass; `bun run test` full suite still green (report count).

- [ ] **Step 5: Commit** `git add packages/api/src/fires-match.ts packages/api/src/fires-match.test.ts && git commit -m "feat(data): FIRMS fire→facility matcher (pure, TDD)"`

### Task 2.2: env + `/api/fires`

**Files:** Modify `packages/api/src/env.ts`, `.env.example`, `packages/api/src/server.ts`

- [ ] **Step 1: env** — add optional `FIRMS_MAP_KEY` following the existing optional-var pattern (same as `ACLED_EMAIL`); add `FIRMS_MAP_KEY=` with a comment to `.env.example`.

- [ ] **Step 2: handler** in server.ts after `handleStrikeImpact`. Parses FIRMS CSV (cols: latitude, longitude, bright_ti4, scan, track, acq_date, acq_time, satellite, instrument, confidence, version, bright_ti5, frp, daynight). Queries ~5 regional bboxes covering our facilities; merges; matches via `matchFiresToFacilities` (import it + `reconTables`/`sql` for facility coords).

```typescript
import { matchFiresToFacilities, type FirePoint, type FacilityPoint } from "./fires-match.ts";
// FIRMS area CSV: dayRange max 5; VIIRS 375m. Regional bboxes "W,S,E,N".
const FIRMS_BBOXES = ["19,44,65,70", "36,50,62,58", "60,52,92,62", "125,42,145,55", "36,41,55,48"];
const FIRMS_SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_SNPP_NRT"];
function parseFirmsCsv(text: string): FirePoint[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0]!.split(",");
  const ix = (n: string) => header.indexOf(n);
  const iLat = ix("latitude"), iLon = ix("longitude"), iConf = ix("confidence"), iFrp = ix("frp"), iDate = ix("acq_date"), iDn = ix("daynight");
  const out: FirePoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i]!.split(",");
    const lat = Number(c[iLat]); const lon = Number(c[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({ lat, lon, confidence: String(c[iConf] ?? "").trim(), frp: Number(c[iFrp]) || 0, acq_date: String(c[iDate] ?? "").trim(), daynight: String(c[iDn] ?? "").trim() });
  }
  return out;
}
async function handleFires(): Promise<Response> {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return jsonResponse({ available: false, points: [], facilities: {}, note: "FIRMS_MAP_KEY not set" });
  const all: FirePoint[] = [];
  for (const src of FIRMS_SOURCES) {
    for (const bbox of FIRMS_BBOXES) {
      try {
        const res = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${src}/${bbox}/3`, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) { logger.warn({ event: "firms_error", status: res.status, src, bbox }, "FIRMS fetch failed"); continue; }
        const text = await res.text();
        if (text.startsWith("Invalid") || text.includes("<html")) { logger.warn({ event: "firms_bad_body", src, bbox, sample: text.slice(0, 60) }, "FIRMS non-CSV"); continue; }
        all.push(...parseFirmsCsv(text));
      } catch (err) { logger.warn({ event: "firms_exception", err: String(err), src, bbox }, "FIRMS threw"); }
    }
  }
  let facilities: Record<string, unknown> = {};
  if (sql) {
    const recon = await reconTables();
    if (recon.infra) {
      const fac = await sql`SELECT id, lat, lon FROM oil_infra WHERE lat IS NOT NULL` as unknown as FacilityPoint[];
      facilities = matchFiresToFacilities(all, fac, 3);
    }
  }
  const burning = Object.values(facilities).filter((a) => (a as { active: boolean }).active).length;
  return jsonResponse({ available: true, count: all.length, burning, points: all, facilities });
}
```

- [ ] **Step 3: route** after `/api/strike-impact`:

```typescript
      if (url.pathname === "/api/fires")             return await withCache(req, 3_600_000, () => handleFires());
```

- [ ] **Step 4: Verify** — `bunx tsc --noEmit`; `curl -s http://localhost:3000/api/fires` (FIRMS_MAP_KEY is in .env) → `available:true`, `count` > 0, `facilities` object (maybe empty if nothing near a plant — report `burning` and a sample facility entry if any).

- [ ] **Step 5: Commit** `git add packages/api/src/env.ts .env.example packages/api/src/server.ts && git commit -m "feat(api): /api/fires — FIRMS thermal anomalies + facility matching"`

### Task 2.3: UI — Fires layer, badge, corroboration

**Files:** Modify `web/index.html`

- [ ] **Step 1: chip + layer + state.** Add chip `data-layer="fires"` after the Attacks chip; `const firesLayer = L.layerGroup().addTo(map);` near other layers; `fires:true` in `layerVisible`; toggle wiring `if (k === "fires") toggleLayer(firesLayer, layerVisible.fires);`. Add module state `let fireFacilities = {};`.

- [ ] **Step 2: loadFires.** Plots points (small orange circleMarkers, radius/opacity by frp) and stores facility aggregates + sets `window.__burningNow`:

```javascript
    async function loadFires() {
      try {
        const res = await fetch("/api/fires");
        const d = await res.json();
        firesLayer.clearLayers();
        fireFacilities = d.facilities || {};
        window.__burningNow = d.burning || 0;
        for (const p of (d.points || [])) {
          const r = p.frp >= 20 ? 5 : 3;
          L.circleMarker([p.lat, p.lon], { radius: r, color: "#ff6a00", weight: 0, fillColor: "#ff6a00", fillOpacity: 0.55, interactive: false }).addTo(firesLayer);
        }
        if (typeof loadImpact === "function") loadImpact();
        if (typeof refreshInfraBadges === "function") refreshInfraBadges();
      } catch (err) { console.error("loadFires failed", err); }
    }
```

Boot: `loadFires();` + `setInterval(loadFires, 3600000)`.

- [ ] **Step 3: facility 🔥 badge.** In `infraIcon(kind, size, struck, burning)` add an optional `burning` flag that adds an orange ring/dot to the SVG (distinct from the red strike badge). In `loadInfra`, compute `const burning = !!(fireFacilities[o.id] && fireFacilities[o.id].active);` and pass it; store on the `infraMarkers` entry; honor in the zoomend re-icon. Add a `refreshInfraBadges()` that re-icons markers when fire data arrives after infra (re-use the zoomend loop body). The marker tooltip gains ` · 🔥 active` when burning.

- [ ] **Step 4: profile row + strike corroboration.** In `openInfraPanel`, when `fireFacilities[o.id]?.active`, add a Profile row: `🔥 active thermal anomaly · ${count} detections (3d) — may include routine flaring`. For strike-history entries, if a FIRMS aggregate exists for this facility and its `last_date` is within ±1 day of the strike's `occurred_on`, append a 🛰 `satellite-corroborated` chip via the existing `attackEntry` `extraChipHtml` param (compute a small helper; combine with any existing auto chip).

- [ ] **Step 5: Verify** — extract inline script + `node --check`; reload page on :3000; confirm: Fires chip toggles orange dots; if any facility active, its marker shows the 🔥 ring and profile row; header tile shows the `🔥` suffix. Report what was observed (live FIRMS may or may not have a fire at a plant today — report honestly).

- [ ] **Step 6: Commit** `git add web/index.html && git commit -m "feat(ux): FIRMS fires layer, facility burn badge, satellite corroboration"`

### Task 2.4: Docs + merge

- [ ] Methodology: FIRMS row in source-provenance table (NASA FIRMS, free key, near-real-time VIIRS thermal anomalies; caveat re flaring) + Infra-bullet sentence. README: `FIRMS_MAP_KEY` config row + Fires layer feature bullet + data-source row.
- [ ] Commit docs; spec+quality review; merge to main (same dance as 3.3), delete branch.

---

## FEATURE 1 — Oil-flow supply chain (branch `feat/oil-flow-chain`)

**File structure:**
- Create `data/infra-links.json` — curated links (research pass) + `locode` added to terminals in `data/oil-infra.json`.
- Create `db/migrate-add-infra-links.sql`, `packages/api/src/cli/load-infra-links.ts`.
- Modify `packages/api/src/server.ts` — reconTables `links`; `handleInfraChain()` + route `/api/infra/:id/chain`; `supply_chain` in `handleVesselDetail`.
- Modify `web/index.html` — Supply-chain section in vessel panel + infra panel; `chainLayer` highlight.

### Task 1.1: Curated links dataset (research pass)

- [ ] Run a research workflow (pattern: the infra/strikes research workflows) to produce `data/infra-links.json` with the shape from the spec — for each major trunk pipeline already in `data/oil-infra.json`: `{pipeline_id, terminal_id, refinery_ids[], commodity, source_urls[]}`, every link cited (GEM/Transneft/press). Cross-check all ids exist in oil-infra.json. Also produce a patch adding `locode` to each export-terminal record in `data/oil-infra.json` (RUPRI Primorsk, RUULU Ust-Luga, RUNVS Novorossiysk, RUKOZ Kozmino, RUTUA Tuapse, RUMUR Murmansk, RUVYS Vysotsk, etc. — match the LOCODEs in `packages/api/src/ports.ts`). QA-gate: ids valid, ≥1 source per link.
- [ ] Commit the datasets.

### Task 1.2: Migration + loader

- [ ] `db/migrate-add-infra-links.sql`: `CREATE TABLE IF NOT EXISTS infra_links (pipeline_id TEXT, terminal_id TEXT, refinery_ids TEXT[], commodity TEXT, source_urls TEXT[], raw JSONB, first_seen TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (pipeline_id, terminal_id))` + index on terminal_id. House-style header, idempotent.
- [ ] `packages/api/src/cli/load-infra-links.ts` mirroring `load-infra-strikes.ts`: parse `{links}`, ensureTable, upsert ON CONFLICT, `sql.json(raw)`. The `locode` patch loads via re-running `load-infra` (oil-infra.json now carries locode in each terminal's record — confirm load-infra maps it; if `oil_infra` needs a `locode` column, add it to migrate-add-infra.sql + load-infra ensureTable + INSERT, and to the SELECT in handleInfra). package.json script `load-infra-links`. reconTables gains `links`.
- [ ] Verify: apply migration, run loader, `SELECT count(*) FROM infra_links`. Commit.

### Task 1.3: Chain API

- [ ] `handleInfraChain(id)` in server.ts: look up any links where the id is the pipeline, terminal, or in refinery_ids; resolve node details (`SELECT id, kind, name, lat, lon FROM oil_infra WHERE id = ANY(...)`); return `{terminal, pipeline, refineries:[...]}` (nulls where not applicable). Route `/api/infra/:id/chain` (regex like the vessel routes; cache 600_000). Graceful empty when `links` table absent.
- [ ] In `handleVesselDetail`: decode the vessel destination LOCODE (already decoded in the cargo/destination block ~line 557); if it maps to a terminal (`SELECT id FROM oil_infra WHERE kind='terminal' AND raw->>'locode' = ${loc}` OR a `locode` column), build the chain and add `supply_chain` to the response.
- [ ] Verify: `curl /api/infra/<terminal-id>/chain` and `/api/infra/<refinery-id>/chain` return chains; a vessel bound for a known terminal gets `supply_chain`. Commit.

### Task 1.4: UI — supply chain sections + map highlight

- [ ] `chainLayer` LayerGroup; helper `drawChain(nodes)` draws polylines linking node coords (distinct style, e.g. dashed cyan) + clears on `closePanel`.
- [ ] Vessel panel: render `data.supply_chain` as a "🛢️ Supply chain" section — terminal → pipeline → refinery chips, each `onclick` flies to + opens that infra panel; opening also calls `drawChain`.
- [ ] Infra panel: fetch `/api/infra/${o.id}/chain` and render the same section (refinery shows downstream; terminal upstream; pipeline both), with `drawChain`.
- [ ] Verify: extract script + `node --check`; click a refinery with links → chain section + highlighted route on map; click a terminal → upstream refineries; click a tanker bound for a terminal → supply chain. Report. Commit.

### Task 1.5: Docs + merge

- [ ] Methodology: infra-links provenance row + Supply-chain sentence. README: loader command + feature bullet.
- [ ] Spec+quality review; merge to main; delete branch.

---

## Self-review notes
- Spec coverage: F3 = Task 3.1-3.3; F2 = 2.1-2.4; F1 = 1.1-1.5. All spec sections mapped.
- Name consistency: endpoints `/api/strike-impact`, `/api/fires`, `/api/infra/:id/chain`; matcher `matchFiresToFacilities`; layers `firesLayer`/`chainLayer`; state `fireFacilities`/`window.__burningNow`; reconTables flags reuse `infra`/`strikes`, add `links`.
- JSONB via `sql.json` everywhere (infra-links loader).
- Graceful degradation: `/api/strike-impact` (tables absent), `/api/fires` (no key), `/api/infra/:id/chain` (links absent) all return `available:false`-style empty.
