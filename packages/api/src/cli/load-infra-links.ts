// Loads curated oil supply-chain links into the infra_links table.
//
// Source: data/infra-links.json — curated terminal↔pipeline↔refinery linkages,
// each tied to facilities in data/oil-infra.json (pipeline_id / terminal_id /
// refinery_ids) and carrying source URLs. Relationships are curated, not
// geometry-guessed (a pipeline passing near a refinery ≠ feeding it).
// Provenance/QA: docs/superpowers/specs/2026-06-11-stories-oilflow-firms-impact-design.md
//
// Shape:
//   { "links": [ { pipeline_id, terminal_id (nullable), refinery_ids: [...],
//                  commodity, source_urls: [...] } ] }
//
// The terminal `locode` lives inside each terminal's record in oil-infra.json
// (loaded into oil_infra.raw by load-infra), NOT here — query via raw->>'locode'.
//
// Run:
//   bun run load-infra-links                       # loads data/infra-links.json
//   bun run load-infra-links path/to/links.json    # loads a custom file

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../db.ts";
import { logger } from "../log.ts";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");
const DEFAULT_FILE = join(DATA_DIR, "infra-links.json");

interface LinkRow {
  id: string;
  pipeline_id: string;
  terminal_id: string | null;
  refinery_ids: string[];
  depot_ids: string[];
  commodity: string | null;
  source_urls: string[];
  raw: Record<string, unknown>;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter((x) => x.length > 0);
}

// Skips rows without a pipeline_id; normalizes nullable terminal_id and the
// synthetic primary key `${pipeline_id}__${terminal_id||'none'}`.
function normalizeLink(raw: Record<string, unknown>): LinkRow | null {
  const pipeline_id = typeof raw.pipeline_id === "string" ? raw.pipeline_id.trim() : "";
  if (!pipeline_id) return null;
  const t = typeof raw.terminal_id === "string" ? raw.terminal_id.trim() : "";
  const terminal_id = t.length > 0 ? t : null;
  return {
    id: `${pipeline_id}__${terminal_id ?? "none"}`,
    pipeline_id,
    terminal_id,
    refinery_ids: asStringArray(raw.refinery_ids),
    depot_ids: asStringArray(raw.depot_ids),
    commodity: typeof raw.commodity === "string" ? raw.commodity.trim() : null,
    source_urls: asStringArray(raw.source_urls),
    raw,
  };
}

async function ensureTable(): Promise<void> {
  await sql!`
    CREATE TABLE IF NOT EXISTS infra_links (
      id            TEXT PRIMARY KEY,
      pipeline_id   TEXT NOT NULL,
      terminal_id   TEXT,
      refinery_ids  TEXT[],
      depot_ids     TEXT[],
      commodity     TEXT,
      source_urls   TEXT[],
      raw           JSONB,
      first_seen    TIMESTAMPTZ DEFAULT NOW()
    )`;
  // Idempotent for databases created before depot_ids existed.
  await sql!`ALTER TABLE infra_links ADD COLUMN IF NOT EXISTS depot_ids TEXT[]`;
  await sql!`CREATE INDEX IF NOT EXISTS infra_links_terminal_idx ON infra_links (terminal_id)`;
  await sql!`CREATE INDEX IF NOT EXISTS infra_links_pipeline_idx ON infra_links (pipeline_id)`;
}

async function main(): Promise<void> {
  if (!sql) {
    logger.error({ event: "no_db" }, "DATABASE_URL not set");
    process.exit(1);
  }

  const file = process.argv[2] ?? DEFAULT_FILE;
  const text = await Bun.file(file).text();
  const parsed = JSON.parse(text) as { links?: Array<Record<string, unknown>> };
  const rows = (parsed.links ?? []).map(normalizeLink).filter((r): r is LinkRow => r !== null);
  const skipped = (parsed.links ?? []).length - rows.length;

  await ensureTable();
  logger.info({ event: "links_parsed", file, count: rows.length, skipped }, "links parsed");

  let inserted = 0;
  for (const r of rows) {
    try {
      await sql`
        INSERT INTO infra_links (
          id, pipeline_id, terminal_id, refinery_ids, depot_ids, commodity, source_urls, raw
        ) VALUES (
          ${r.id}, ${r.pipeline_id}, ${r.terminal_id},
          ${r.refinery_ids}::text[], ${r.depot_ids}::text[], ${r.commodity},
          ${r.source_urls}::text[], ${sql.json(r.raw as Parameters<typeof sql.json>[0])}
        )
        ON CONFLICT (id) DO UPDATE SET
          pipeline_id = EXCLUDED.pipeline_id, terminal_id = EXCLUDED.terminal_id,
          refinery_ids = EXCLUDED.refinery_ids, depot_ids = EXCLUDED.depot_ids,
          commodity = EXCLUDED.commodity,
          source_urls = EXCLUDED.source_urls, raw = EXCLUDED.raw
      `;
      inserted++;
    } catch (err) {
      logger.error({ event: "insert_error", err: String(err), id: r.id }, "link insert failed");
    }
  }

  logger.info({ event: "links_loaded", inserted, total: rows.length, skipped }, "links loaded");
  await sql.end({ timeout: 5 });
}

void main();
