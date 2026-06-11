// Loads Ukrainian strikes on Russian oil facilities into the infra_strikes table.
//
// Source: data/infra-strikes.json — REAL per-event strike records, each tied to
// a facility in data/oil-infra.json (infra_id) and carrying source URLs
// (>=2 independent or 1 authoritative). Provenance and QA:
// docs/superpowers/specs/2026-06-10-infra-strikes-addendum.md
//
// Run:
//   bun run load-infra-strikes                       # loads data/infra-strikes.json
//   bun run load-infra-strikes path/to/strikes.json  # loads a custom file

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../db.ts";
import { logger } from "../log.ts";
import { normalizeStrike, type StrikeRow } from "../infra-normalize.ts";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");
const DEFAULT_FILE = join(DATA_DIR, "infra-strikes.json");

async function ensureTable(): Promise<void> {
  await sql!`
    CREATE TABLE IF NOT EXISTS infra_strikes (
      id          TEXT PRIMARY KEY,
      infra_id    TEXT NOT NULL,
      occurred_on DATE NOT NULL,
      weapon      TEXT,
      summary     TEXT,
      source_urls TEXT[],
      raw         JSONB,
      first_seen  TIMESTAMPTZ DEFAULT NOW(),
      origin      TEXT NOT NULL DEFAULT 'curated',
      verified    BOOLEAN NOT NULL DEFAULT TRUE
    )`;
  // Pre-origin installs: bring the table up to date (idempotent, matches
  // db/migrate-add-strike-origin.sql).
  await sql!`ALTER TABLE infra_strikes ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'curated'`;
  await sql!`ALTER TABLE infra_strikes ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT TRUE`;
  // Per-strike severity (impact-methodology revamp, matches
  // db/migrate-add-strike-origin.sql) — curated damage classification.
  await sql!`ALTER TABLE infra_strikes ADD COLUMN IF NOT EXISTS severity TEXT`;
  await sql!`CREATE INDEX IF NOT EXISTS infra_strikes_infra_idx ON infra_strikes (infra_id)`;
  await sql!`CREATE INDEX IF NOT EXISTS infra_strikes_occurred_on_idx ON infra_strikes (occurred_on DESC)`;
}

async function main(): Promise<void> {
  if (!sql) {
    logger.error({ event: "no_db" }, "DATABASE_URL not set");
    process.exit(1);
  }

  const file = process.argv[2] ?? DEFAULT_FILE;
  const text = await Bun.file(file).text();
  const parsed = JSON.parse(text) as { strikes?: Array<Record<string, unknown>> };
  const rows = (parsed.strikes ?? []).map(normalizeStrike).filter((r): r is StrikeRow => r !== null);
  const skipped = (parsed.strikes ?? []).length - rows.length;

  await ensureTable();
  logger.info({ event: "strikes_parsed", file, count: rows.length, skipped }, "strikes parsed");

  let inserted = 0;
  const facilities = new Set<string>();
  for (const r of rows) {
    facilities.add(r.infra_id);
    try {
      await sql`
        INSERT INTO infra_strikes (
          id, infra_id, occurred_on, weapon, severity, summary, source_urls, raw, origin, verified
        ) VALUES (
          ${r.id}, ${r.infra_id}, ${r.occurred_on}, ${r.weapon}, ${r.severity}, ${r.summary},
          ${r.source_urls}::text[], ${sql.json(r.raw as Parameters<typeof sql.json>[0])},
          'curated', TRUE
        )
        ON CONFLICT (id) DO UPDATE SET
          infra_id = EXCLUDED.infra_id, occurred_on = EXCLUDED.occurred_on,
          weapon = EXCLUDED.weapon, severity = EXCLUDED.severity, summary = EXCLUDED.summary,
          source_urls = EXCLUDED.source_urls, raw = EXCLUDED.raw,
          origin = EXCLUDED.origin, verified = EXCLUDED.verified
      `;
      inserted++;
    } catch (err) {
      logger.error({ event: "insert_error", err: String(err), id: r.id }, "strike insert failed");
    }
  }

  logger.info({ event: "strikes_loaded", inserted, total: rows.length, skipped, facilities: facilities.size }, "strikes loaded");
  await sql.end({ timeout: 5 });
}

void main();
