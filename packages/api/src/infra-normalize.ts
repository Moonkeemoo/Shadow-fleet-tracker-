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

/** Like toNum but rejects values outside [min, max] — used for lat/lon. */
function toCoord(v: unknown, min: number, max: number): number | null {
  const n = toNum(v);
  if (n === null) return null;
  return n >= min && n <= max ? n : null;
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

  const lat = toCoord(raw.lat, -90, 90);
  const lon = toCoord(raw.lon, -180, 180);
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
  // Reject impossible calendar dates (e.g. 2023-13-45) via round-trip check.
  const d = new Date(occurred_on + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== occurred_on) return null;

  const lat = toCoord(raw.lat, -90, 90);
  const lon = toCoord(raw.lon, -180, 180);
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
