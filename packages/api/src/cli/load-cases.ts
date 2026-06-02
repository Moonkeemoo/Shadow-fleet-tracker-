// Loads documented investigative cases into the known_cases table.
//
// Sources: curate from public investigations — KSE Institute Russian Oil Tracker,
// CREA shadow-fleet trackers, United Against Nuclear Iran tanker tracker, OCCRP,
// and press reporting. Map each named vessel to its IMO. The known_cases table
// doubles as a ground-truth set for calibrating the risk weights.
// The shipped seed is synthetic example data.
//
// Run:
//   bun run load-cases                     # loads data/known-cases.seed.json
//   bun run load-cases path/to/cases.json  # loads a custom file

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../db.ts";
import { logger } from "../log.ts";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");
const DEFAULT_FILE = join(DATA_DIR, "known-cases.seed.json");

interface CaseRow {
  id: string;
  title: string;
  summary: string | null;
  source: string | null;
  source_url: string | null;
  published_on: string | null;
  tags: string[];
  imos: number[];
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function normalize(raw: Record<string, unknown>): CaseRow | null {
  const title = toStr(raw.title);
  if (!title) return null;
  const id = toStr(raw.id) ?? slugify(title);
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean) : [];
  const imos = Array.isArray(raw.imos)
    ? raw.imos.map((n) => parseInt(String(n), 10)).filter((n) => Number.isFinite(n) && n >= 1000000 && n <= 9999999)
    : [];
  return {
    id,
    title,
    summary: toStr(raw.summary),
    source: toStr(raw.source),
    source_url: toStr(raw.source_url),
    published_on: toStr(raw.published_on),
    tags,
    imos,
  };
}

async function ensureTable(): Promise<void> {
  await sql!`
    CREATE TABLE IF NOT EXISTS known_cases (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      summary      TEXT,
      source       TEXT,
      source_url   TEXT,
      published_on DATE,
      tags         TEXT[],
      imos         BIGINT[],
      first_seen   TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql!`CREATE INDEX IF NOT EXISTS cases_imos_idx ON known_cases USING GIN (imos)`;
  await sql!`CREATE INDEX IF NOT EXISTS cases_source_idx ON known_cases (source)`;
}

async function main(): Promise<void> {
  if (!sql) {
    logger.error({ event: "no_db" }, "DATABASE_URL not set");
    process.exit(1);
  }

  const file = process.argv[2] ?? DEFAULT_FILE;
  const text = await Bun.file(file).text();
  const parsed = JSON.parse(text) as { cases?: Array<Record<string, unknown>> };
  const rows = (parsed.cases ?? []).map(normalize).filter((r): r is CaseRow => r !== null);

  await ensureTable();
  logger.info({ event: "cases_parsed", file, count: rows.length }, "cases parsed");

  let inserted = 0;
  let vesselLinks = 0;
  for (const r of rows) {
    vesselLinks += r.imos.length;
    try {
      await sql`
        INSERT INTO known_cases (id, title, summary, source, source_url, published_on, tags, imos)
        VALUES (
          ${r.id}, ${r.title}, ${r.summary}, ${r.source}, ${r.source_url}, ${r.published_on},
          ${r.tags}::text[], ${r.imos}::bigint[]
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title, summary = EXCLUDED.summary, source = EXCLUDED.source,
          source_url = EXCLUDED.source_url, published_on = EXCLUDED.published_on,
          tags = EXCLUDED.tags, imos = EXCLUDED.imos
      `;
      inserted++;
    } catch (err) {
      logger.error({ event: "insert_error", err: String(err), id: r.id }, "case insert failed");
    }
  }

  logger.info({ event: "cases_loaded", inserted, total: rows.length, vesselLinks }, "cases loaded");
  await sql.end({ timeout: 5 });
}

void main();
