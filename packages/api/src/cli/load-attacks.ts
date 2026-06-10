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
