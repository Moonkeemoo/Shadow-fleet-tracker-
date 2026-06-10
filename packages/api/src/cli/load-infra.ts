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
          ${r.geometry ? sql.json(r.geometry as Parameters<typeof sql.json>[0]) : null}, ${r.commodity},
          ${r.capacity_mt_yr}, ${r.capacity_bbl_d}, ${r.storage_m3}, ${r.throughput_mt_yr},
          ${r.owner}, ${r.operator}, ${r.region}, ${r.status}, ${r.notes},
          ${r.source_urls}::text[], ${sql.json(r.raw as Parameters<typeof sql.json>[0])}
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
