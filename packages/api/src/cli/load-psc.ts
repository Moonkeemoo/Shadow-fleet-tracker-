// Loads Port State Control detentions into the psc_detentions table.
//
// Source: Paris MoU and Tokyo MoU publish public "current detentions" lists.
// They have no clean API, so the workflow is: export the public list to the
// JSON shape in data/psc-detentions.seed.json (or a CSV with the same columns)
// and load it here. The shipped seed is synthetic example data.
//
// Run:
//   bun run load-psc                       # loads data/psc-detentions.seed.json
//   bun run load-psc path/to/export.json   # loads a custom file (.json or .csv)
//
// CSV header (if using CSV): imo,vessel_name,flag,authority,port,detained_on,released_on,deficiencies,detention_days,source_url

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../db.ts";
import { logger } from "../log.ts";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");
const DEFAULT_FILE = join(DATA_DIR, "psc-detentions.seed.json");

interface DetentionRow {
  imo: number | null;
  vessel_name: string | null;
  flag: string | null;
  authority: string;
  port: string | null;
  detained_on: string | null;
  released_on: string | null;
  deficiencies: number | null;
  detention_days: number | null;
  source_url: string | null;
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function parseCsv(text: string): DetentionRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const rows: DetentionRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",");
    const get = (name: string) => cols[idx(name)]?.trim() ?? "";
    rows.push({
      imo: toInt(get("imo")),
      vessel_name: toStr(get("vessel_name")),
      flag: toStr(get("flag")),
      authority: toStr(get("authority")) ?? "unknown",
      port: toStr(get("port")),
      detained_on: toStr(get("detained_on")),
      released_on: toStr(get("released_on")),
      deficiencies: toInt(get("deficiencies")),
      detention_days: toInt(get("detention_days")),
      source_url: toStr(get("source_url")),
    });
  }
  return rows;
}

function normalize(raw: Record<string, unknown>): DetentionRow {
  return {
    imo: toInt(raw.imo),
    vessel_name: toStr(raw.vessel_name),
    flag: toStr(raw.flag)?.toLowerCase() ?? null,
    authority: toStr(raw.authority) ?? "unknown",
    port: toStr(raw.port),
    detained_on: toStr(raw.detained_on),
    released_on: toStr(raw.released_on),
    deficiencies: toInt(raw.deficiencies),
    detention_days: toInt(raw.detention_days),
    source_url: toStr(raw.source_url),
  };
}

async function ensureTable(): Promise<void> {
  await sql!`
    CREATE TABLE IF NOT EXISTS psc_detentions (
      id             TEXT PRIMARY KEY,
      imo            BIGINT,
      vessel_name    TEXT,
      flag           TEXT,
      authority      TEXT NOT NULL,
      port           TEXT,
      detained_on    DATE,
      released_on    DATE,
      deficiencies   INTEGER,
      detention_days INTEGER,
      source_url     TEXT,
      raw            JSONB,
      first_seen     TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql!`CREATE INDEX IF NOT EXISTS psc_imo_idx ON psc_detentions (imo) WHERE imo IS NOT NULL`;
  await sql!`CREATE INDEX IF NOT EXISTS psc_detained_on_idx ON psc_detentions (detained_on DESC)`;
}

async function main(): Promise<void> {
  if (!sql) {
    logger.error({ event: "no_db" }, "DATABASE_URL not set");
    process.exit(1);
  }

  const file = process.argv[2] ?? DEFAULT_FILE;
  const text = await Bun.file(file).text();

  let rows: DetentionRow[];
  if (file.toLowerCase().endsWith(".csv")) {
    rows = parseCsv(text);
  } else {
    const parsed = JSON.parse(text) as { detentions?: Array<Record<string, unknown>> };
    rows = (parsed.detentions ?? []).map(normalize);
  }

  await ensureTable();
  logger.info({ event: "psc_parsed", file, count: rows.length }, "PSC detentions parsed");

  let inserted = 0;
  for (const r of rows) {
    const id = `${r.authority}|${r.imo ?? "?"}|${r.detained_on ?? "?"}`;
    try {
      await sql`
        INSERT INTO psc_detentions
          (id, imo, vessel_name, flag, authority, port, detained_on, released_on, deficiencies, detention_days, source_url, raw)
        VALUES (
          ${id}, ${r.imo}, ${r.vessel_name}, ${r.flag}, ${r.authority}, ${r.port},
          ${r.detained_on}, ${r.released_on}, ${r.deficiencies}, ${r.detention_days}, ${r.source_url},
          ${JSON.stringify(r)}::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET
          imo = EXCLUDED.imo, vessel_name = EXCLUDED.vessel_name, flag = EXCLUDED.flag,
          port = EXCLUDED.port, released_on = EXCLUDED.released_on,
          deficiencies = EXCLUDED.deficiencies, detention_days = EXCLUDED.detention_days,
          source_url = EXCLUDED.source_url, raw = EXCLUDED.raw
      `;
      inserted++;
    } catch (err) {
      logger.error({ event: "insert_error", err: String(err), id }, "PSC insert failed");
    }
  }

  logger.info({ event: "psc_loaded", inserted, total: rows.length }, "PSC detentions loaded");
  await sql.end({ timeout: 5 });
}

void main();
