# Oil Infrastructure + Tanker Attacks Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two map layers to the Shadow Fleet Tracker — Russian oil infrastructure (refineries, depots, terminals, pipelines) and Russia-linked tanker-attack incidents — with DB-backed reference data, API endpoints, side-panel cards, and methodology docs.

**Architecture:** Follows the project's established recon pattern exactly: real curated JSON in `data/` → CLI loader (`packages/api/src/cli/load-*.ts`) → Postgres tables → cached API endpoints in `server.ts` (guarded by the `reconTables()` existence check) → Leaflet LayerGroups with chip toggles in the single-file `web/index.html`. Normalization logic lives in a pure module so it is unit-testable with `node --test` (same pattern as `risk.ts` / `risk.test.ts`).

**Tech Stack:** Bun, postgres-js, TimescaleDB/Postgres 16, Leaflet 1.9.4, vanilla JS (no build step), node:test.

**Data dependency:** `data/oil-infra.json` and `data/tanker-attacks.json` are produced by a separate research workflow (real, cited records — NOT synthetic seeds). Tasks 1–9 do not need these files to exist; Task 10 (verification) does. The loader code must match the data schema given in Task 1 — the research output conforms to the same schema.

**Spec:** `docs/superpowers/specs/2026-06-10-oil-infra-attacks-layer-design.md`

**Branch:** work on `feat/oil-infra-attacks-layer` (already created). Commit after every task; push after every 2–3 commits (`git push`).

---

### Task 1: Pure normalization module (TDD)

**Files:**
- Create: `packages/api/src/infra-normalize.ts`
- Test: `packages/api/src/infra-normalize.test.ts`

The input JSON schema (produced by the research workflow, consumed by loaders):

`data/oil-infra.json` = `{"objects": [InfraRecord...]}` where InfraRecord has: `id` (kebab-case), `kind` (`refinery|depot|terminal|pipeline`), `name`, `name_local|null`, `lat|null` (null only for pipelines), `lon|null`, `geometry|null` (GeoJSON LineString/MultiLineString, pipelines only), `commodity` (`crude|products|null`), `capacity_mt_yr|null`, `capacity_bbl_d|null`, `storage_m3|null`, `throughput_mt_yr|null`, `owner|null`, `operator|null`, `region|null`, `status` (`operational|damaged|unknown`), `notes|null`, `source_urls` (string[], ≥1).

`data/tanker-attacks.json` = `{"attacks": [AttackRecord...]}` where AttackRecord has: `id` (`YYYY-MM-DD-slug`), `occurred_on` (`YYYY-MM-DD`), `vessel_name|null`, `imo|null` (7-digit), `lat`, `lon`, `location_precision` (`exact|approx|port`), `attack_type` (`usv_strike|limpet_mine|port_strike|explosion_unexplained`), `summary`, `source_urls` (string[], ≥1).

- [ ] **Step 1: Write the failing tests**

Create `packages/api/src/infra-normalize.test.ts`:

```typescript
// Unit tests for the pure infra/attack record normalization.
// Pure module (no Bun/Postgres deps) — runnable with: node --test packages/api/src/infra-normalize.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInfra, normalizeAttack } from "./infra-normalize.ts";

const REFINERY = {
  id: "ryazan-refinery",
  kind: "refinery",
  name: "Ryazan Oil Refinery",
  name_local: "Рязанский НПЗ",
  lat: 54.56, lon: 39.79,
  geometry: null,
  commodity: null,
  capacity_mt_yr: 17.1, capacity_bbl_d: null,
  storage_m3: null, throughput_mt_yr: null,
  owner: "Rosneft", operator: null, region: "Ryazan Oblast",
  status: "operational", notes: null,
  source_urls: ["https://example.org/ryazan"],
};

test("valid refinery normalizes", () => {
  const r = normalizeInfra(REFINERY);
  assert.ok(r);
  assert.equal(r.id, "ryazan-refinery");
  assert.equal(r.kind, "refinery");
  assert.equal(r.lat, 54.56);
  assert.equal(r.status, "operational");
  assert.deepEqual(r.source_urls, ["https://example.org/ryazan"]);
});

test("point object without coordinates is rejected", () => {
  assert.equal(normalizeInfra({ ...REFINERY, lat: null }), null);
});

test("record without sources is rejected — every record must be cited", () => {
  assert.equal(normalizeInfra({ ...REFINERY, source_urls: [] }), null);
  assert.equal(normalizeInfra({ ...REFINERY, source_urls: ["not-a-url"] }), null);
});

test("unknown kind is rejected", () => {
  assert.equal(normalizeInfra({ ...REFINERY, kind: "powerplant" }), null);
});

test("bogus status falls back to unknown", () => {
  const r = normalizeInfra({ ...REFINERY, status: "thriving" });
  assert.ok(r);
  assert.equal(r.status, "unknown");
});

test("pipeline requires geometry instead of lat/lon", () => {
  const pipe = {
    ...REFINERY,
    id: "bts-2", kind: "pipeline", name: "BTS-2",
    lat: null, lon: null, commodity: "crude",
    geometry: { type: "LineString", coordinates: [[34.3, 53.2], [28.4, 59.66]] },
  };
  const r = normalizeInfra(pipe);
  assert.ok(r);
  assert.equal(r.kind, "pipeline");
  assert.ok(r.geometry);
  assert.equal(normalizeInfra({ ...pipe, geometry: null }), null);
});

const ATTACK = {
  id: "2023-08-05-sig",
  occurred_on: "2023-08-05",
  vessel_name: "SIG",
  imo: 9735335,
  lat: 44.8, lon: 36.7,
  location_precision: "approx",
  attack_type: "usv_strike",
  summary: "Ukrainian naval drone struck the tanker SIG near the Kerch Strait.",
  source_urls: ["https://www.reuters.com/example"],
};

test("valid attack normalizes", () => {
  const a = normalizeAttack(ATTACK);
  assert.ok(a);
  assert.equal(a.id, "2023-08-05-sig");
  assert.equal(a.imo, 9735335);
  assert.equal(a.attack_type, "usv_strike");
});

test("attack with bad date is rejected", () => {
  assert.equal(normalizeAttack({ ...ATTACK, occurred_on: "August 2023" }), null);
  assert.equal(normalizeAttack({ ...ATTACK, occurred_on: null }), null);
});

test("attack without coordinates or sources is rejected", () => {
  assert.equal(normalizeAttack({ ...ATTACK, lat: null }), null);
  assert.equal(normalizeAttack({ ...ATTACK, source_urls: [] }), null);
});

test("attack with invalid type is rejected, bad precision falls back to approx", () => {
  assert.equal(normalizeAttack({ ...ATTACK, attack_type: "torpedo" }), null);
  const a = normalizeAttack({ ...ATTACK, location_precision: "fuzzy" });
  assert.ok(a);
  assert.equal(a.location_precision, "approx");
});

test("non-7-digit IMO becomes null", () => {
  const a = normalizeAttack({ ...ATTACK, imo: 12345 });
  assert.ok(a);
  assert.equal(a.imo, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:\Users\tomoo\Documents\GitHub\Shadow-fleet-tracker- && node --test packages/api/src/infra-normalize.test.ts`
Expected: FAIL — `Cannot find module ... infra-normalize.ts`

- [ ] **Step 3: Write the implementation**

Create `packages/api/src/infra-normalize.ts`:

```typescript
// Pure normalization for the oil-infrastructure and tanker-attacks reference
// datasets (data/oil-infra.json / data/tanker-attacks.json). Every record must
// carry at least one http(s) source URL — uncited records are dropped.
// No Bun/Postgres deps — unit-testable with node --test.

export interface InfraRow {
  id: string;
  kind: "refinery" | "depot" | "terminal" | "pipeline";
  name: string;
  name_local: string | null;
  lat: number | null;
  lon: number | null;
  geometry: Record<string, unknown> | null;
  commodity: string | null;
  capacity_mt_yr: number | null;
  capacity_bbl_d: number | null;
  storage_m3: number | null;
  throughput_mt_yr: number | null;
  owner: string | null;
  operator: string | null;
  region: string | null;
  status: "operational" | "damaged" | "unknown";
  notes: string | null;
  source_urls: string[];
  raw: Record<string, unknown>;
}

export interface AttackRow {
  id: string;
  occurred_on: string;
  vessel_name: string | null;
  imo: number | null;
  lat: number;
  lon: number;
  location_precision: "exact" | "approx" | "port";
  attack_type: "usv_strike" | "limpet_mine" | "port_strike" | "explosion_unexplained";
  summary: string | null;
  source_urls: string[];
  raw: Record<string, unknown>;
}

const INFRA_KINDS = new Set(["refinery", "depot", "terminal", "pipeline"]);
const STATUSES = new Set(["operational", "damaged", "unknown"]);
const ATTACK_TYPES = new Set(["usv_strike", "limpet_mine", "port_strike", "explosion_unexplained"]);
const PRECISIONS = new Set(["exact", "approx", "port"]);

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toUrls(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(String).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
}

export function normalizeInfra(raw: Record<string, unknown>): InfraRow | null {
  const id = toStr(raw.id);
  const name = toStr(raw.name);
  const kind = toStr(raw.kind);
  if (!id || !name || !kind || !INFRA_KINDS.has(kind)) return null;

  const source_urls = toUrls(raw.source_urls);
  if (source_urls.length === 0) return null;

  const lat = toNum(raw.lat);
  const lon = toNum(raw.lon);
  const geometry =
    raw.geometry && typeof raw.geometry === "object" && !Array.isArray(raw.geometry)
      ? (raw.geometry as Record<string, unknown>)
      : null;

  if (kind === "pipeline") {
    if (!geometry) return null;
  } else if (lat === null || lon === null) {
    return null;
  }

  const statusRaw = toStr(raw.status);
  const status = statusRaw && STATUSES.has(statusRaw) ? statusRaw : "unknown";

  return {
    id,
    kind: kind as InfraRow["kind"],
    name,
    name_local: toStr(raw.name_local),
    lat,
    lon,
    geometry,
    commodity: toStr(raw.commodity),
    capacity_mt_yr: toNum(raw.capacity_mt_yr),
    capacity_bbl_d: toNum(raw.capacity_bbl_d),
    storage_m3: toNum(raw.storage_m3),
    throughput_mt_yr: toNum(raw.throughput_mt_yr),
    owner: toStr(raw.owner),
    operator: toStr(raw.operator),
    region: toStr(raw.region),
    status: status as InfraRow["status"],
    notes: toStr(raw.notes),
    source_urls,
    raw,
  };
}

export function normalizeAttack(raw: Record<string, unknown>): AttackRow | null {
  const id = toStr(raw.id);
  const occurred_on = toStr(raw.occurred_on);
  if (!id || !occurred_on || !/^\d{4}-\d{2}-\d{2}$/.test(occurred_on)) return null;

  const lat = toNum(raw.lat);
  const lon = toNum(raw.lon);
  if (lat === null || lon === null) return null;

  const attack_type = toStr(raw.attack_type);
  if (!attack_type || !ATTACK_TYPES.has(attack_type)) return null;

  const source_urls = toUrls(raw.source_urls);
  if (source_urls.length === 0) return null;

  const precisionRaw = toStr(raw.location_precision);
  const location_precision = precisionRaw && PRECISIONS.has(precisionRaw) ? precisionRaw : "approx";

  const imoNum = toNum(raw.imo);
  const imo = imoNum !== null && imoNum >= 1000000 && imoNum <= 9999999 ? Math.trunc(imoNum) : null;

  return {
    id,
    occurred_on,
    vessel_name: toStr(raw.vessel_name),
    imo,
    lat,
    lon,
    location_precision: location_precision as AttackRow["location_precision"],
    attack_type: attack_type as AttackRow["attack_type"],
    summary: toStr(raw.summary),
    source_urls,
    raw,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test packages/api/src/infra-normalize.test.ts`
Expected: all tests PASS. Also run the full suite: `bun run test` — `risk.test.ts` must still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/infra-normalize.ts packages/api/src/infra-normalize.test.ts
git commit -m "feat(data): pure normalization for oil-infra + tanker-attack records"
```

---

### Task 2: DB migration

**Files:**
- Create: `db/migrate-add-infra.sql`

- [ ] **Step 1: Write the migration**

Create `db/migrate-add-infra.sql`:

```sql
-- Adds reference layers: Russian oil infrastructure + Russia-linked tanker attacks.
-- Powers the /api/infra and /api/attacks endpoints and the "Infra" / "Attacks"
-- map layers in the UI. Data: data/oil-infra.json, data/tanker-attacks.json
-- (real, cited records — see docs/superpowers/specs/2026-06-10-infra-attacks-data-report.md).
--
-- Idempotent. Run via:
--   docker compose exec -T postgres psql -U shadow -d shadow -f /tmp/migrate-add-infra.sql
-- The loaders (load-infra.ts / load-attacks.ts) also create these tables on first
-- run, so a separate migration step is optional.

-- Oil infrastructure: refineries, depots/tank farms, marine export terminals,
-- trunk pipelines (geometry = simplified GeoJSON LineString/MultiLineString).
CREATE TABLE IF NOT EXISTS oil_infra (
  id               TEXT PRIMARY KEY,      -- stable kebab-case slug
  kind             TEXT NOT NULL,         -- 'refinery' | 'depot' | 'terminal' | 'pipeline'
  name             TEXT NOT NULL,
  name_local       TEXT,
  lat              REAL,                  -- NULL for pipelines
  lon              REAL,
  geometry         JSONB,                 -- pipelines only
  commodity        TEXT,                  -- 'crude' | 'products' (pipelines)
  capacity_mt_yr   REAL,                  -- refineries: refining capacity, Mt/yr
  capacity_bbl_d   REAL,
  storage_m3       REAL,                  -- depots/terminals
  throughput_mt_yr REAL,                  -- pipelines/terminals
  owner            TEXT,
  operator         TEXT,
  region           TEXT,
  status           TEXT,                  -- 'operational' | 'damaged' | 'unknown'
  notes            TEXT,
  source_urls      TEXT[],
  raw              JSONB,
  first_seen       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS oil_infra_kind_name_idx ON oil_infra (kind, name);

-- Russia-linked attacks on tankers (USV strikes, limpet mines, port strikes,
-- unexplained explosions). imo links incidents to vessel detail panels.
CREATE TABLE IF NOT EXISTS tanker_attacks (
  id                 TEXT PRIMARY KEY,    -- YYYY-MM-DD-slug
  occurred_on        DATE NOT NULL,
  vessel_name        TEXT,
  imo                BIGINT,
  lat                REAL NOT NULL,
  lon                REAL NOT NULL,
  location_precision TEXT,                -- 'exact' | 'approx' | 'port'
  attack_type        TEXT NOT NULL,       -- 'usv_strike' | 'limpet_mine' | 'port_strike' | 'explosion_unexplained'
  summary            TEXT,
  source_urls        TEXT[],
  raw                JSONB,
  first_seen         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attacks_imo_idx         ON tanker_attacks (imo) WHERE imo IS NOT NULL;
CREATE INDEX IF NOT EXISTS attacks_occurred_on_idx ON tanker_attacks (occurred_on DESC);
```

- [ ] **Step 2: Sanity-check the SQL parses (no DB needed yet — visual check against `db/migrate-add-recon.sql` style), then commit**

```bash
git add db/migrate-add-infra.sql
git commit -m "feat(db): oil_infra + tanker_attacks reference tables"
```

---

### Task 3: Loader `load-infra.ts`

**Files:**
- Create: `packages/api/src/cli/load-infra.ts`
- Modify: `package.json` (scripts block, after `"load-cases"` line)

- [ ] **Step 1: Write the loader**

Create `packages/api/src/cli/load-infra.ts`:

```typescript
// Loads the Russian oil-infrastructure reference layer into the oil_infra table.
//
// Source: data/oil-infra.json — REAL curated records (refineries, depots,
// terminals, pipelines) compiled from Global Energy Monitor (CC BY),
// Wikipedia/Wikidata, CREA and OSM, each with source URLs. Provenance and QA:
// docs/superpowers/specs/2026-06-10-infra-attacks-data-report.md
//
// Run:
//   bun run load-infra                     # loads data/oil-infra.json
//   bun run load-infra path/to/infra.json  # loads a custom file

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../db.ts";
import { logger } from "../log.ts";
import { normalizeInfra, type InfraRow } from "../infra-normalize.ts";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");
const DEFAULT_FILE = join(DATA_DIR, "oil-infra.json");

async function ensureTable(): Promise<void> {
  await sql!`
    CREATE TABLE IF NOT EXISTS oil_infra (
      id               TEXT PRIMARY KEY,
      kind             TEXT NOT NULL,
      name             TEXT NOT NULL,
      name_local       TEXT,
      lat              REAL,
      lon              REAL,
      geometry         JSONB,
      commodity        TEXT,
      capacity_mt_yr   REAL,
      capacity_bbl_d   REAL,
      storage_m3       REAL,
      throughput_mt_yr REAL,
      owner            TEXT,
      operator         TEXT,
      region           TEXT,
      status           TEXT,
      notes            TEXT,
      source_urls      TEXT[],
      raw              JSONB,
      first_seen       TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql!`CREATE INDEX IF NOT EXISTS oil_infra_kind_name_idx ON oil_infra (kind, name)`;
}

async function main(): Promise<void> {
  if (!sql) {
    logger.error({ event: "no_db" }, "DATABASE_URL not set");
    process.exit(1);
  }

  const file = process.argv[2] ?? DEFAULT_FILE;
  const text = await Bun.file(file).text();
  const parsed = JSON.parse(text) as { objects?: Array<Record<string, unknown>> };
  const rows = (parsed.objects ?? []).map(normalizeInfra).filter((r): r is InfraRow => r !== null);
  const skipped = (parsed.objects ?? []).length - rows.length;

  await ensureTable();
  logger.info({ event: "infra_parsed", file, count: rows.length, skipped }, "infra parsed");

  let inserted = 0;
  for (const r of rows) {
    try {
      await sql`
        INSERT INTO oil_infra (
          id, kind, name, name_local, lat, lon, geometry, commodity,
          capacity_mt_yr, capacity_bbl_d, storage_m3, throughput_mt_yr,
          owner, operator, region, status, notes, source_urls, raw
        ) VALUES (
          ${r.id}, ${r.kind}, ${r.name}, ${r.name_local}, ${r.lat}, ${r.lon},
          ${r.geometry ? JSON.stringify(r.geometry) : null}::jsonb, ${r.commodity},
          ${r.capacity_mt_yr}, ${r.capacity_bbl_d}, ${r.storage_m3}, ${r.throughput_mt_yr},
          ${r.owner}, ${r.operator}, ${r.region}, ${r.status}, ${r.notes},
          ${r.source_urls}::text[], ${JSON.stringify(r.raw)}::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET
          kind = EXCLUDED.kind, name = EXCLUDED.name, name_local = EXCLUDED.name_local,
          lat = EXCLUDED.lat, lon = EXCLUDED.lon, geometry = EXCLUDED.geometry,
          commodity = EXCLUDED.commodity, capacity_mt_yr = EXCLUDED.capacity_mt_yr,
          capacity_bbl_d = EXCLUDED.capacity_bbl_d, storage_m3 = EXCLUDED.storage_m3,
          throughput_mt_yr = EXCLUDED.throughput_mt_yr, owner = EXCLUDED.owner,
          operator = EXCLUDED.operator, region = EXCLUDED.region, status = EXCLUDED.status,
          notes = EXCLUDED.notes, source_urls = EXCLUDED.source_urls, raw = EXCLUDED.raw
      `;
      inserted++;
    } catch (err) {
      logger.error({ event: "insert_error", err: String(err), id: r.id }, "infra insert failed");
    }
  }

  logger.info({ event: "infra_loaded", inserted, total: rows.length, skipped }, "infra loaded");
  await sql.end({ timeout: 5 });
}

void main();
```

- [ ] **Step 2: Register the script in `package.json`**

In the root `package.json`, after the line `"load-cases": "bun run packages/api/src/cli/load-cases.ts",` add:

```json
    "load-infra": "bun run packages/api/src/cli/load-infra.ts",
```

- [ ] **Step 3: Type-check**

Run: `cd C:\Users\tomoo\Documents\GitHub\Shadow-fleet-tracker- && bunx tsc --noEmit`
Expected: no NEW errors versus `git stash && bunx tsc --noEmit && git stash pop` baseline (the repo may have pre-existing diagnostics; only the delta matters).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/cli/load-infra.ts package.json
git commit -m "feat(data): oil-infrastructure loader (load-infra)"
```

---

### Task 4: Loader `load-attacks.ts`

**Files:**
- Create: `packages/api/src/cli/load-attacks.ts`
- Modify: `package.json` (scripts block, after the new `"load-infra"` line)

- [ ] **Step 1: Write the loader**

Create `packages/api/src/cli/load-attacks.ts`:

```typescript
// Loads Russia-linked tanker-attack incidents into the tanker_attacks table.
//
// Source: data/tanker-attacks.json — REAL incidents 2022-2026 (Ukrainian USV
// strikes, limpet mines, port strikes, unexplained explosions), each with
// source URLs (>=2 independent or 1 authoritative). Provenance and QA:
// docs/superpowers/specs/2026-06-10-infra-attacks-data-report.md
//
// Run:
//   bun run load-attacks                       # loads data/tanker-attacks.json
//   bun run load-attacks path/to/attacks.json  # loads a custom file

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../db.ts";
import { logger } from "../log.ts";
import { normalizeAttack, type AttackRow } from "../infra-normalize.ts";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");
const DEFAULT_FILE = join(DATA_DIR, "tanker-attacks.json");

async function ensureTable(): Promise<void> {
  await sql!`
    CREATE TABLE IF NOT EXISTS tanker_attacks (
      id                 TEXT PRIMARY KEY,
      occurred_on        DATE NOT NULL,
      vessel_name        TEXT,
      imo                BIGINT,
      lat                REAL NOT NULL,
      lon                REAL NOT NULL,
      location_precision TEXT,
      attack_type        TEXT NOT NULL,
      summary            TEXT,
      source_urls        TEXT[],
      raw                JSONB,
      first_seen         TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql!`CREATE INDEX IF NOT EXISTS attacks_imo_idx ON tanker_attacks (imo) WHERE imo IS NOT NULL`;
  await sql!`CREATE INDEX IF NOT EXISTS attacks_occurred_on_idx ON tanker_attacks (occurred_on DESC)`;
}

async function main(): Promise<void> {
  if (!sql) {
    logger.error({ event: "no_db" }, "DATABASE_URL not set");
    process.exit(1);
  }

  const file = process.argv[2] ?? DEFAULT_FILE;
  const text = await Bun.file(file).text();
  const parsed = JSON.parse(text) as { attacks?: Array<Record<string, unknown>> };
  const rows = (parsed.attacks ?? []).map(normalizeAttack).filter((r): r is AttackRow => r !== null);
  const skipped = (parsed.attacks ?? []).length - rows.length;

  await ensureTable();
  logger.info({ event: "attacks_parsed", file, count: rows.length, skipped }, "attacks parsed");

  let inserted = 0;
  let imoLinks = 0;
  for (const r of rows) {
    if (r.imo !== null) imoLinks++;
    try {
      await sql`
        INSERT INTO tanker_attacks (
          id, occurred_on, vessel_name, imo, lat, lon,
          location_precision, attack_type, summary, source_urls, raw
        ) VALUES (
          ${r.id}, ${r.occurred_on}, ${r.vessel_name}, ${r.imo}, ${r.lat}, ${r.lon},
          ${r.location_precision}, ${r.attack_type}, ${r.summary},
          ${r.source_urls}::text[], ${JSON.stringify(r.raw)}::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET
          occurred_on = EXCLUDED.occurred_on, vessel_name = EXCLUDED.vessel_name,
          imo = EXCLUDED.imo, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
          location_precision = EXCLUDED.location_precision, attack_type = EXCLUDED.attack_type,
          summary = EXCLUDED.summary, source_urls = EXCLUDED.source_urls, raw = EXCLUDED.raw
      `;
      inserted++;
    } catch (err) {
      logger.error({ event: "insert_error", err: String(err), id: r.id }, "attack insert failed");
    }
  }

  logger.info({ event: "attacks_loaded", inserted, total: rows.length, skipped, imoLinks }, "attacks loaded");
  await sql.end({ timeout: 5 });
}

void main();
```

- [ ] **Step 2: Register the script in `package.json`**

After the `"load-infra"` line add:

```json
    "load-attacks": "bun run packages/api/src/cli/load-attacks.ts",
```

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit` — no new errors.

- [ ] **Step 4: Commit + push**

```bash
git add packages/api/src/cli/load-attacks.ts package.json
git commit -m "feat(data): tanker-attacks loader (load-attacks)"
git push
```

---

### Task 5: API endpoints `/api/infra` + `/api/attacks`

**Files:**
- Modify: `packages/api/src/server.ts` — three places:
  1. the `reconTables()` guard (lines ~100–115),
  2. new handlers next to `handleZones`/`handleCases` (after line ~1799),
  3. route registration in `Bun.serve` fetch (lines ~1866–1894).

- [ ] **Step 1: Extend the `reconTables()` existence check**

Replace the existing block (server.ts ~lines 100–115):

```typescript
let _reconTables: { psc: boolean; cases: boolean; crea: boolean } | null = null;
async function reconTables(): Promise<{ psc: boolean; cases: boolean; crea: boolean }> {
  if (_reconTables) return _reconTables;
  if (!sql) return { psc: false, cases: false, crea: false };
  try {
    const r = await sql`SELECT to_regclass('public.psc_detentions') AS psc, to_regclass('public.known_cases') AS cases, to_regclass('public.crea_vessels') AS crea`;
    _reconTables = { psc: !!r[0]?.psc, cases: !!r[0]?.cases, crea: !!r[0]?.crea };
  } catch {
    _reconTables = { psc: false, cases: false, crea: false };
  }
  return _reconTables;
}
```

with:

```typescript
let _reconTables: { psc: boolean; cases: boolean; crea: boolean; infra: boolean; attacks: boolean } | null = null;
async function reconTables(): Promise<{ psc: boolean; cases: boolean; crea: boolean; infra: boolean; attacks: boolean }> {
  if (_reconTables) return _reconTables;
  if (!sql) return { psc: false, cases: false, crea: false, infra: false, attacks: false };
  try {
    const r = await sql`SELECT to_regclass('public.psc_detentions') AS psc, to_regclass('public.known_cases') AS cases, to_regclass('public.crea_vessels') AS crea, to_regclass('public.oil_infra') AS infra, to_regclass('public.tanker_attacks') AS attacks`;
    _reconTables = { psc: !!r[0]?.psc, cases: !!r[0]?.cases, crea: !!r[0]?.crea, infra: !!r[0]?.infra, attacks: !!r[0]?.attacks };
  } catch {
    _reconTables = { psc: false, cases: false, crea: false, infra: false, attacks: false };
  }
  return _reconTables;
}
```

- [ ] **Step 2: Add the handlers**

Insert after `handleCases` (after server.ts line ~1799):

```typescript
// Oil-infrastructure reference layer (refineries / depots / terminals / pipelines).
// Optional filter: ?kind=refinery  ?kind=pipeline
async function handleInfra(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const recon = await reconTables();
  if (!recon.infra) {
    return jsonResponse({ count: 0, objects: [], note: "oil_infra table absent — run db/migrate-add-infra.sql then bun run load-infra" });
  }
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");

  const rows = await sql`
    SELECT id, kind, name, name_local, lat, lon, geometry, commodity,
           capacity_mt_yr, capacity_bbl_d, storage_m3, throughput_mt_yr,
           owner, operator, region, status, notes, source_urls
    FROM oil_infra
    WHERE TRUE
      ${kind ? sql`AND kind = ${kind}` : sql``}
    ORDER BY kind, name
    LIMIT 1000
  `;
  return jsonResponse({ count: rows.length, objects: rows });
}

// Russia-linked tanker-attack incidents.
// Optional filters: ?since=2024-01-01  ?imo=9735335  ?format=csv
// (?since instead of the usual ?range — incidents span 2022-2026 while
//  parseRange caps at 90 days.)
async function handleAttacks(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const recon = await reconTables();
  if (!recon.attacks) {
    return jsonResponse({ count: 0, results: [], note: "tanker_attacks table absent — run db/migrate-add-infra.sql then bun run load-attacks" });
  }
  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  const sinceValid = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : null;
  const imo = parseInt(url.searchParams.get("imo") ?? "", 10);

  const rows = await sql`
    SELECT id, occurred_on, vessel_name, imo::text AS imo, lat, lon,
           location_precision, attack_type, summary, source_urls
    FROM tanker_attacks
    WHERE TRUE
      ${sinceValid ? sql`AND occurred_on >= ${sinceValid}` : sql``}
      ${Number.isFinite(imo) ? sql`AND imo = ${imo}` : sql``}
    ORDER BY occurred_on DESC
    LIMIT 500
  `;

  return maybeCsvOrJson(req, rows as unknown as Array<Record<string, unknown>>,
    `tanker-attacks-${new Date().toISOString().slice(0, 10)}.csv`,
    ["occurred_on", "vessel_name", "imo", "attack_type", "lat", "lon", "location_precision", "summary", "source_urls"]);
}
```

- [ ] **Step 3: Register the routes**

In the `Bun.serve` fetch handler, after the line
`if (url.pathname === "/api/zones")             return await withCache(req, 600_000, () => handleZones());`
add:

```typescript
      if (url.pathname === "/api/infra")             return await withCache(req, 600_000, () => handleInfra(req));
      if (url.pathname === "/api/attacks")           return await withCache(req, 300_000, () => handleAttacks(req));
```

- [ ] **Step 4: Type-check and run tests**

Run: `bunx tsc --noEmit` (no new errors) and `bun run test` (passes).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/server.ts
git commit -m "feat(api): /api/infra and /api/attacks reference endpoints"
```

---

### Task 6: Attacks in vessel detail response

**Files:**
- Modify: `packages/api/src/server.ts` — inside `handleVesselDetail` (the recon block at ~lines 502–534 and the response object at ~lines 560–586).

- [ ] **Step 1: Query attacks by IMO**

After the `if (recon.cases) { ... }` block (ends ~line 519) add:

```typescript
  let vesselAttacks: Array<Record<string, unknown>> = [];
  if (recon.attacks) {
    vesselAttacks = await sql`
      SELECT id, occurred_on, vessel_name, attack_type, lat, lon,
             location_precision, summary, source_urls
      FROM tanker_attacks WHERE imo = ${imo}
      ORDER BY occurred_on DESC LIMIT 20
    `;
  }
```

- [ ] **Step 2: Add to the response**

In the `return jsonResponse({ ... })` of `handleVesselDetail`, after the line `cases: knownCases,` add:

```typescript
    attacks: vesselAttacks,
```

- [ ] **Step 3: Type-check, test, commit + push**

Run: `bunx tsc --noEmit && bun run test`

```bash
git add packages/api/src/server.ts
git commit -m "feat(api): attack incidents in vessel detail by IMO"
git push
```

---

### Task 7: UI — map layers, icons, loaders, toggles

**Files:**
- Modify: `web/index.html` — chips (~line 920–924), layer setup (~line 980–992), icon helpers (after `cleanTankerDot`, ~line 1030), data loaders (next to `loadZones`, ~line 1160), toggle wiring (~line 1199–1213), boot (~line 2070–2079), timeline legend (~line 950–954).

All JS below is vanilla, inline in the existing `<script>` block — match surrounding style (2-space indent, double quotes).

- [ ] **Step 1: Add chips**

After `<span class="chip layer-chip active" data-layer="clean">Clean</span>` add:

```html
        <span class="chip layer-chip active" data-layer="infra">Infra</span>
        <span class="chip layer-chip active" data-layer="attacks">Attacks</span>
```

- [ ] **Step 2: Layer groups + state**

After `const zonesLayer = L.layerGroup().addTo(map);` add (before vessel layers so vessels stay visually on top):

```javascript
    const infraLayer = L.layerGroup().addTo(map);
    const attacksLayer = L.layerGroup().addTo(map);
```

Replace `const layerVisible = { zones: true, sts: true, clean: true };` with:

```javascript
    const layerVisible = { zones: true, sts: true, clean: true, infra: true, attacks: true };
```

- [ ] **Step 3: Icon helpers**

After the `cleanTankerDot` function add:

```javascript
    // -------- Infra & attack icons
    const INFRA_COLORS = { refinery: "#b56cff", depot: "#2bcbba", terminal: "#54a0ff" };
    function infraIconSize() { return map.getZoom() >= 5 ? 18 : 12; }
    function infraIcon(kind, size) {
      const c = INFRA_COLORS[kind] || "#8a96aa";
      let shape;
      if (kind === "refinery") {
        // factory: chimney + roofline
        shape = `<path d="M2 13 L2 6 L4 6 L4 9 L7 7 L7 9 L10 7 L10 13 Z" fill="${c}" stroke="#fff" stroke-width="0.5"/>`;
      } else if (kind === "depot") {
        // storage tank: cylinder
        shape = `<rect x="2.5" y="5" width="7" height="7" rx="1.2" fill="${c}" stroke="#fff" stroke-width="0.5"/><ellipse cx="6" cy="5" rx="3.5" ry="1.4" fill="${c}" stroke="#fff" stroke-width="0.5"/>`;
      } else {
        // terminal: diamond
        shape = `<path d="M6 1.5 L11 7 L6 12.5 L1 7 Z" fill="${c}" stroke="#fff" stroke-width="0.5"/>`;
      }
      return L.divIcon({
        className: "infra-icon",
        html: `<svg viewBox="0 0 12 14" width="${size}" height="${size}">${shape}</svg>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
    }
    function attackIcon() {
      return L.divIcon({
        className: "attack-icon",
        html: `<svg viewBox="0 0 14 14" width="16" height="16">
          <path d="M7 0 L8.6 4.4 L13 3 L9.8 7 L13 11 L8.6 9.6 L7 14 L5.4 9.6 L1 11 L4.2 7 L1 3 L5.4 4.4 Z" fill="#ff4757" stroke="#fff" stroke-width="0.5"/>
        </svg>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
    }
```

- [ ] **Step 4: Data loaders**

After the `loadZones` function add:

```javascript
    // -------- Infra layer (refineries / depots / terminals / pipelines)
    let infraMarkers = []; // { marker, kind } — re-iconed on zoom threshold crossings
    async function loadInfra() {
      try {
        const res = await fetch("/api/infra");
        const data = await res.json();
        infraLayer.clearLayers();
        infraMarkers = [];
        const size = infraIconSize();
        for (const o of (data.objects || [])) {
          if (o.kind === "pipeline" && o.geometry) {
            const style = o.commodity === "products"
              ? { color: "#7bd5f5", weight: 1.5, opacity: 0.5, dashArray: "6 4" }
              : { color: "#e0a458", weight: 2, opacity: 0.5 };
            const line = L.geoJSON(o.geometry, { style });
            line.bindTooltip(`${o.name}${o.commodity ? " · " + o.commodity : ""}`, { sticky: true });
            line.on("click", () => openInfraPanel(o));
            line.addTo(infraLayer);
          } else if (o.lat != null && o.lon != null) {
            const marker = L.marker([o.lat, o.lon], { icon: infraIcon(o.kind, size) });
            marker.bindTooltip(`${o.name}${o.capacity_mt_yr ? ` · ${o.capacity_mt_yr} Mt/yr` : ""}`);
            marker.on("click", () => openInfraPanel(o));
            marker.addTo(infraLayer);
            infraMarkers.push({ marker, kind: o.kind });
          }
        }
      } catch (err) { console.error("loadInfra failed", err); }
    }
    map.on("zoomend", () => {
      const size = infraIconSize();
      for (const m of infraMarkers) m.marker.setIcon(infraIcon(m.kind, size));
    });

    // -------- Attacks layer (Russia-linked tanker incidents)
    async function loadAttacks() {
      try {
        const res = await fetch("/api/attacks");
        const data = await res.json();
        attacksLayer.clearLayers();
        for (const a of (data.results || [])) {
          const marker = L.marker([a.lat, a.lon], { icon: attackIcon() });
          marker.bindTooltip(`${a.vessel_name || "Unknown vessel"} · ${a.occurred_on ? new Date(a.occurred_on).toLocaleDateString() : "—"}`);
          marker.on("click", () => openAttackPanel(a));
          marker.addTo(attacksLayer);
        }
      } catch (err) { console.error("loadAttacks failed", err); }
    }
```

(`openInfraPanel` / `openAttackPanel` are defined in Task 8 — within this task add temporary one-line stubs right before `loadInfra` so the file stays runnable, and REPLACE them in Task 8:)

```javascript
    function openInfraPanel(o) { console.log("infra", o.id); }
    function openAttackPanel(a) { console.log("attack", a.id); }
```

- [ ] **Step 5: Toggle wiring**

In the layer-chip click handler, after `if (k === "clean")  toggleLayer(cleanLayer,  layerVisible.clean);` add:

```javascript
        if (k === "infra")   toggleLayer(infraLayer,   layerVisible.infra);
        if (k === "attacks") toggleLayer(attacksLayer, layerVisible.attacks);
```

- [ ] **Step 6: Boot + refresh**

In the Boot block, after `loadSts();` add:

```javascript
    loadInfra();
    loadAttacks();
```

and after `setInterval(loadSts, 30000);` add:

```javascript
    setInterval(loadAttacks, 600000); // attacks are curated — 10 min is plenty; infra is static, no refresh
```

- [ ] **Step 7: Timeline legend additions**

In the `tl-legend` div, after the last `<div class="li">…all tankers…</div>` add:

```html
        <div class="li"><span class="swatch" style="background: #b56cff;"></span> oil infra</div>
        <div class="li"><span class="swatch" style="background: #ff4757; border-radius: 0;"></span> tanker attack</div>
```

- [ ] **Step 8: Smoke-check in browser (no DB rows yet — layers just stay empty, no console errors), commit**

Run: `bun run serve` then open `http://localhost:3000` — check DevTools console: no errors from `loadInfra`/`loadAttacks` (endpoints return the "table absent" note shape, loops over empty arrays). Chips Infra/Attacks toggle without errors.

```bash
git add web/index.html
git commit -m "feat(ux): Infra + Attacks map layers with chip toggles"
```

---

### Task 8: UI — side-panel cards + vessel-panel Attacks section

**Files:**
- Modify: `web/index.html` — replace the Task-7 stubs (before `loadInfra`) with full panel renderers; add an Attacks section in `renderVesselPanel` (after the Documented-cases block, ~line 1521).

- [ ] **Step 1: Replace the stubs with real panel renderers**

Replace the two stub lines from Task 7 with:

```javascript
    // -------- Panel: infra object card
    const ATTACK_TYPE_LABELS = {
      usv_strike: "Naval-drone (USV) strike",
      limpet_mine: "Limpet-mine attack",
      port_strike: "Strike in port",
      explosion_unexplained: "Unexplained explosion",
    };
    const INFRA_KIND_LABELS = { refinery: "Refinery", depot: "Oil depot / tank farm", terminal: "Export terminal", pipeline: "Trunk pipeline" };
    function sourceLinks(urls) {
      return (urls || []).map((u, i) =>
        `<a href="${escapeHtml(u)}" target="_blank" rel="noopener" style="display:inline-block;margin-right:8px;font-size:10px;color:var(--c-blue);text-decoration:none;">↗ source ${i + 1}</a>`
      ).join("");
    }
    function openInfraPanel(o) {
      const panel = document.getElementById("panel");
      panel.classList.add("open");
      document.getElementById("p-name").textContent = o.name;
      document.getElementById("p-sub").textContent = `${INFRA_KIND_LABELS[o.kind] || o.kind}${o.region ? " · " + o.region : ""}`;
      const c = INFRA_COLORS[o.kind] || "#e0a458";
      const damaged = o.status === "damaged";
      let html = `<div class="section" style="border-left: 3px solid ${c};">
        <h3>🏭 ${escapeHtml(INFRA_KIND_LABELS[o.kind] || o.kind)}</h3>
        ${o.name_local ? `<div class="row"><span class="label">Local name</span><span class="value">${escapeHtml(o.name_local)}</span></div>` : ""}
        ${o.owner ? `<div class="row"><span class="label">Owner</span><span class="value">${escapeHtml(o.owner)}</span></div>` : ""}
        ${o.operator ? `<div class="row"><span class="label">Operator</span><span class="value">${escapeHtml(o.operator)}</span></div>` : ""}
        ${o.capacity_mt_yr != null ? `<div class="row"><span class="label">Capacity</span><span class="value">${o.capacity_mt_yr} Mt/yr${o.capacity_bbl_d ? ` · ${Number(o.capacity_bbl_d).toLocaleString()} bbl/d` : ""}</span></div>` : ""}
        ${o.storage_m3 != null ? `<div class="row"><span class="label">Storage</span><span class="value">${Number(o.storage_m3).toLocaleString()} m³</span></div>` : ""}
        ${o.throughput_mt_yr != null ? `<div class="row"><span class="label">Throughput</span><span class="value">${o.throughput_mt_yr} Mt/yr</span></div>` : ""}
        ${o.commodity ? `<div class="row"><span class="label">Commodity</span><span class="value">${escapeHtml(o.commodity)}</span></div>` : ""}
        <div class="row"><span class="label">Status</span><span class="value" style="color:${damaged ? "var(--c-red)" : "var(--text-1)"};font-weight:${damaged ? "700" : "400"};">${escapeHtml(o.status || "unknown")}</span></div>
        ${o.notes ? `<div style="font-size:11px;color:var(--text-1);line-height:1.45;margin-top:6px;">${escapeHtml(o.notes)}</div>` : ""}
        <div style="margin-top:8px;">${sourceLinks(o.source_urls)}</div>
      </div>
      <div class="section"><div style="font-size:10px;color:var(--c-muted);">Reference layer — public sources (GEM CC BY, Wikipedia, CREA, OSM). Capacities vary between sources and over time; see methodology.</div></div>`;
      document.getElementById("p-body").innerHTML = html;
    }

    // -------- Panel: attack incident card
    function openAttackPanel(a) {
      const panel = document.getElementById("panel");
      panel.classList.add("open");
      document.getElementById("p-name").textContent = a.vessel_name || "Unknown vessel";
      document.getElementById("p-sub").textContent = `${ATTACK_TYPE_LABELS[a.attack_type] || a.attack_type} · ${a.occurred_on ? new Date(a.occurred_on).toLocaleDateString() : "—"}`;
      let html = `<div class="section" style="background: linear-gradient(180deg, rgba(255,71,87,0.10), transparent); border-left: 3px solid var(--c-red);">
        <h3>💥 ${escapeHtml(ATTACK_TYPE_LABELS[a.attack_type] || a.attack_type)}</h3>
        <div class="row"><span class="label">Date</span><span class="value">${a.occurred_on ? new Date(a.occurred_on).toLocaleDateString() : "—"}</span></div>
        ${a.vessel_name ? `<div class="row"><span class="label">Vessel</span><span class="value">${escapeHtml(a.vessel_name)}</span></div>` : ""}
        ${a.imo ? `<div class="row"><span class="label">IMO</span><span class="value"><span onclick="openVessel(${Number(a.imo)})" style="cursor:pointer;color:var(--c-blue);">${escapeHtml(String(a.imo))} ↗ open vessel</span></span></div>` : ""}
        ${a.summary ? `<div style="font-size:11px;color:var(--text-1);line-height:1.45;margin:6px 0;">${escapeHtml(a.summary)}</div>` : ""}
        ${a.location_precision !== "exact" ? `<div style="margin-top:6px;padding:5px 9px;background:var(--bg-3);border-radius:4px;font-size:10px;color:var(--c-muted);">⚠ Location is ${a.location_precision === "port" ? "the port area" : "approximate"} — at-sea incident coordinates come from press reports.</div>` : ""}
        <div style="margin-top:8px;">${sourceLinks(a.source_urls)}</div>
      </div>`;
      document.getElementById("p-body").innerHTML = html;
    }
```

- [ ] **Step 2: Attacks section in the vessel panel**

In `renderVesselPanel`, after the Documented-cases block (the `if (vcases.length > 0) { ... }` that ends ~line 1521) add:

```javascript
      // Attacks on this vessel (reference layer: tanker_attacks)
      const vattacks = data.attacks || [];
      if (vattacks.length > 0) {
        html += `<div class="section" style="background: linear-gradient(180deg, rgba(255,71,87,0.10), transparent); border-left: 3px solid var(--c-red);">
          <h3>💥 Attack incidents · ${vattacks.length}</h3>
          ${vattacks.map(a => `
            <div style="margin-bottom: 8px; padding: 8px 10px; background: var(--bg-2); border-radius: 4px; border-left: 2px solid var(--c-red);">
              <div style="font-weight: 600; font-size: 12px; color: var(--text-0);">${escapeHtml(ATTACK_TYPE_LABELS[a.attack_type] || a.attack_type)}</div>
              <div style="font-size: 10px; color: var(--text-2); margin: 2px 0;">${a.occurred_on ? new Date(a.occurred_on).toLocaleDateString() : "—"}</div>
              ${a.summary ? `<div style="font-size: 11px; color: var(--text-1); line-height: 1.45;">${escapeHtml(String(a.summary).slice(0, 300))}</div>` : ""}
              <div style="margin-top:4px;">${sourceLinks(a.source_urls)}</div>
            </div>`).join("")}
        </div>`;
      }
```

- [ ] **Step 3: Browser smoke-check, commit + push**

Run `bun run serve`, open the map, click chips — still no console errors (panels render only on click; with empty tables nothing to click yet, which is fine).

```bash
git add web/index.html
git commit -m "feat(ux): infra/attack side-panel cards + vessel-panel attack section"
git push
```

---

### Task 9: Methodology + README

**Files:**
- Modify: `web/methodology.html` — new section before the limitations section (~line 690), new rows in the source-provenance table (~lines 311–357), refresh-cadence additions (~lines 718–732).
- Modify: `README.md` — features list + loader workflow.

- [ ] **Step 1: Methodology — source table rows**

In the source-provenance table in `web/methodology.html`, following the existing row format (inspect the surrounding `<tr>` markup and match it exactly), add rows:

- `Global Energy Monitor — Global Oil Infrastructure Tracker` | refineries, pipelines (locations, capacities, routes) | CC BY 4.0 (public) | manual, quarterly
- `Wikipedia / Wikidata` | refinery & terminal cross-checks, local names | CC BY-SA / CC0 | manual, quarterly
- `OpenStreetMap` | pipeline route geometry cross-checks | ODbL | manual, quarterly
- `Press reports (Reuters / AP / BBC / FT / Kyiv Independent / Naval News …)` | tanker-attack incidents | public articles, linked per record | manual, ongoing curation

- [ ] **Step 2: Methodology — new section**

Before the limitations section add a new numbered section (match the existing `<h2>`/section markup style of the file):

```html
<h2>Oil infrastructure &amp; tanker-attack layers</h2>
<p>Two static reference layers add land-side context to the live vessel picture:</p>
<ul>
  <li><strong>Infra</strong> — Russian oil refineries, major depots/tank farms, marine export
    terminals and trunk pipelines (simplified routes). Compiled from Global Energy Monitor
    (CC BY 4.0), Wikipedia/Wikidata, CREA publications and OpenStreetMap. Every record carries
    its source links, visible in the object card.</li>
  <li><strong>Attacks</strong> — Russia-linked attacks on tankers 2022–2026: Ukrainian naval-drone
    strikes, limpet-mine attacks, strikes hitting tankers inside Russian ports, and unexplained
    explosions on shadow-fleet vessels. Each incident requires ≥2 independent sources or one
    authoritative source (Reuters/AP/BBC/FT/official statements). Incidents with a known IMO
    link to the vessel detail panel.</li>
</ul>
<p><strong>Caveats.</strong> At-sea incident coordinates are approximate (press-derived) and flagged
as such per record. Refinery capacities differ between sources and change over time — values are
indicative, not authoritative. Facility status (operational/damaged) changes faster than this
dataset; treat it as a snapshot, not live state. The incident list is curated, not exhaustive.
Pipeline routes are simplified for journalistic context, not engineering precision.</p>
<p>Datasets ship as <code>data/oil-infra.json</code> and <code>data/tanker-attacks.json</code>
(real, cited records). Bulk access: <code>/api/infra</code>, <code>/api/attacks?format=csv</code>.
Provenance &amp; QA detail: <code>docs/superpowers/specs/2026-06-10-infra-attacks-data-report.md</code>.</p>
```

- [ ] **Step 3: Methodology — refresh cadence**

In the refresh-cadence list add: `Oil infrastructure: manual reload, quarterly` and `Tanker attacks: manual reload, ongoing curation`.

- [ ] **Step 4: README**

In `README.md`:
1. Features list — after the "Live map" bullet add:
   ```markdown
   - **Oil-infrastructure layer** — Russian refineries, depots, export terminals and trunk
     pipelines with capacity/owner cards and per-record source links (`/api/infra`).
   - **Tanker-attacks layer** — Russia-linked attacks on tankers 2022–2026 (USV strikes,
     limpet mines, port strikes) with incident cards; linked to vessel panels by IMO
     (`/api/attacks`, CSV export).
   ```
2. In the loader/daily-workflow section (lines ~150–177 and ~260–268), add alongside the other loaders:
   ```markdown
   bun run load-infra      # oil-infrastructure reference layer (data/oil-infra.json)
   bun run load-attacks    # tanker-attack incidents (data/tanker-attacks.json)
   ```

- [ ] **Step 5: Commit**

```bash
git add web/methodology.html README.md
git commit -m "docs: methodology + README for infra and attacks layers"
```

---

### Task 10: End-to-end verification (needs data files + Docker DB)

**Pre-req:** `data/oil-infra.json` and `data/tanker-attacks.json` exist (research workflow output) and Docker is running.

- [ ] **Step 1: Start DB + apply migration**

```bash
cd C:\Users\tomoo\Documents\GitHub\Shadow-fleet-tracker-
bun run db:up
docker compose cp db/migrate-add-infra.sql postgres:/tmp/migrate-add-infra.sql
docker compose exec -T postgres psql -U shadow -d shadow -f /tmp/migrate-add-infra.sql
```

Expected: `CREATE TABLE` / `CREATE INDEX` notices, no errors.

- [ ] **Step 2: Run loaders**

```bash
bun run load-infra
bun run load-attacks
```

Expected: `infra loaded` with inserted ≈ record count and skipped=0 (investigate every skipped record — it means the research data violates the schema); same for attacks.

- [ ] **Step 3: Endpoint checks**

Start `bun run serve`, then:

```powershell
(Invoke-WebRequest http://localhost:3000/api/infra).Content | ConvertFrom-Json | Select-Object count
(Invoke-WebRequest "http://localhost:3000/api/infra?kind=pipeline").Content | ConvertFrom-Json | Select-Object count
(Invoke-WebRequest http://localhost:3000/api/attacks).Content | ConvertFrom-Json | Select-Object count
(Invoke-WebRequest "http://localhost:3000/api/attacks?format=csv").Content | Select-Object -First 3
```

Expected: counts > 0 matching loader outputs; pipeline filter returns only pipelines; CSV starts with the header row.
For a vessel with a known incident IMO (take one from `data/tanker-attacks.json` with non-null imo):
`(Invoke-WebRequest http://localhost:3000/api/vessel/<IMO>).Content | ConvertFrom-Json | Select-Object -ExpandProperty attacks` → the incident appears (vessel must exist in `vessels`; if not, just verify the endpoint returns without error and `attacks` is present in the JSON shape).

- [ ] **Step 4: Full test suite + smoke**

```bash
bun run test
bun run smoke
```

Expected: all tests pass; smoke OK.

- [ ] **Step 5: Visual check**

Open `http://localhost:3000`: refineries/depots/terminals/pipelines render over Russia; attack markers in the Black Sea/Med/Baltic; chips toggle layers; click a refinery → card with capacity/owner/sources; click an attack → incident card; zoom in/out past level 5 → marker size changes. Take a screenshot for the record (headless CDP or manual).

- [ ] **Step 6: Commit data files + final push**

```bash
git add data/oil-infra.json data/tanker-attacks.json docs/superpowers/specs/2026-06-10-infra-attacks-data-report.md
git commit -m "feat(data): real oil-infra + tanker-attacks datasets with per-record sources"
git push
```

---

## Self-review checklist (run after all tasks)

1. Spec coverage: data files real+cited (Task 10 gate + research report), migration (T2), loaders (T3/T4), endpoints + graceful degradation (T5), vessel-detail attacks (T6), layers/chips/icons/zoom (T7), panels + IMO link (T8), methodology/README (T9), verification (T10). Future phases intentionally absent.
2. Names consistent: table `oil_infra`/`tanker_attacks`; endpoints `/api/infra`/`/api/attacks`; JSON shapes `{count, objects}` / `{count, results}`; UI reads `data.objects` / `data.results`; vessel detail key `attacks`.
3. No placeholders; every code step contains full code.
