import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./db.ts";
import { logger } from "./log.ts";
import { SUSPECT_ZONES, findZone } from "./zones.ts";
import { computeRisk, isFlagOfConvenience, flagHopCount, vesselAgeYears, detectSpoofJumps, type RiskInputs, type TrackPoint } from "./risk.ts";
import { parseDestination, inferLoadStatus, inferCargoType, externalLinks, sentinelVerifyUrl, findNearestPort } from "./ports.ts";
import { matchFiresToFacilities, filterNearFacilities, type FirePoint, type FacilityPoint } from "./fires-match.ts";
import { fetchFirmsPoints } from "./firms-fetch.ts";
import { fillMonthlySeries } from "./impact-series.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
const WEB_DIR = join(__dirname, "..", "..", "..", "web");

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

function jsonReplacer(_key: string, val: unknown): unknown {
  return typeof val === "bigint" ? val.toString() : val;
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, jsonReplacer), {
    ...init,
    headers: { "content-type": "application/json", ...corsHeaders, ...(init?.headers ?? {}) },
  });
}

// Convert array of flat objects to RFC-4180 CSV. First row is header.
function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return "";
  const cols = columns ?? Object.keys(rows[0]!);
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    let s: string;
    if (v instanceof Date) s = v.toISOString();
    else if (Array.isArray(v)) s = v.join("|");
    else if (typeof v === "object") s = JSON.stringify(v);
    else if (typeof v === "boolean") s = v ? "true" : "false";
    else s = String(v);
    if (s.includes('"') || s.includes(",") || s.includes("\n")) {
      s = `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => escape(r[c])).join(","));
  return lines.join("\n");
}

function csvResponse(rows: Array<Record<string, unknown>>, filename: string, columns?: string[]): Response {
  const body = toCsv(rows, columns);
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      ...corsHeaders,
    },
  });
}

// Simple in-memory response cache for hot GET endpoints.
// Keyed by full URL (path + query). TTL configurable per call.
// Avoids hammering Postgres with identical concurrent queries from UI auto-refresh.
const respCache = new Map<string, { ts: number; body: string; headers: Record<string, string> }>();
const RESP_CACHE_DEFAULT_TTL_MS = 20_000; // 20 s — matches UI refresh cadence

async function withCache(req: Request, ttlMs: number, fn: () => Promise<Response>): Promise<Response> {
  const url = new URL(req.url);
  const key = url.pathname + url.search;
  const hit = respCache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) {
    return new Response(hit.body, { headers: { ...hit.headers, "x-cache": "HIT" } });
  }
  const res = await fn();
  // Only cache successful JSON responses
  if (res.status === 200 && res.headers.get("content-type")?.includes("json")) {
    const body = await res.clone().text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    respCache.set(key, { ts: Date.now(), body, headers });
    // Periodic prune: when cache exceeds 200 entries, drop the oldest 50
    if (respCache.size > 200) {
      const sorted = [...respCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (const [k] of sorted.slice(0, 50)) respCache.delete(k);
    }
  }
  return res;
}

function maybeCsvOrJson(req: Request | undefined, rows: Array<Record<string, unknown>>, filename: string, columns?: string[], extra?: Record<string, unknown>): Response {
  const url = req ? new URL(req.url) : null;
  const fmt = url?.searchParams.get("format")?.toLowerCase();
  if (fmt === "csv") return csvResponse(rows, filename, columns);
  return jsonResponse({ count: rows.length, ...extra, results: rows });
}

const SANCTIONED_COUNTRIES = ["ru", "ir", "kp", "by", "sy", "ve"];

// Recon tables (psc_detentions, known_cases) are added by db/migrate-add-recon.sql.
// They may be absent on databases provisioned before that migration, so every
// query that touches them is guarded by this one-time, cached existence check —
// keeping the API fully backward-compatible.
let _reconTables: { psc: boolean; cases: boolean; crea: boolean; infra: boolean; attacks: boolean; strikes: boolean; links: boolean; outage: boolean } | null = null;
async function reconTables(): Promise<{ psc: boolean; cases: boolean; crea: boolean; infra: boolean; attacks: boolean; strikes: boolean; links: boolean; outage: boolean }> {
  if (_reconTables) return _reconTables;
  if (!sql) return { psc: false, cases: false, crea: false, infra: false, attacks: false, strikes: false, links: false, outage: false };
  try {
    const r = await sql`SELECT to_regclass('public.psc_detentions') AS psc, to_regclass('public.known_cases') AS cases, to_regclass('public.crea_vessels') AS crea, to_regclass('public.oil_infra') AS infra, to_regclass('public.tanker_attacks') AS attacks, to_regclass('public.infra_strikes') AS strikes, to_regclass('public.infra_links') AS links, to_regclass('public.refining_outage') AS outage`;
    _reconTables = { psc: !!r[0]?.psc, cases: !!r[0]?.cases, crea: !!r[0]?.crea, infra: !!r[0]?.infra, attacks: !!r[0]?.attacks, strikes: !!r[0]?.strikes, links: !!r[0]?.links, outage: !!r[0]?.outage };
  } catch {
    _reconTables = { psc: false, cases: false, crea: false, infra: false, attacks: false, strikes: false, links: false, outage: false };
  }
  return _reconTables;
}

// Continuous near-stationary dwell inside a suspect zone (STS / sanctioned-port
// approach) is the behavioural fingerprint of an STS rendezvous or sanctioned
// loading. Walks a chronological track and returns the longest such dwell in
// minutes plus the zone it occurred in.
function detectLoitering(
  track: TrackPoint[],
  maxKn = 1.0,
): { minutes: number; zone: string | null } {
  let best = 0;
  let bestZone: string | null = null;
  let curStart: number | null = null;
  let curZone: string | null = null;
  for (const p of track) {
    const slow = (p.sog ?? 99) <= maxKn;
    const zone = slow ? findZone(p.lat, p.lon) : null;
    const t = new Date(p.ts).getTime();
    if (zone) {
      if (curStart === null || curZone !== zone.name) {
        curStart = t;
        curZone = zone.name;
      }
      const dwell = (t - curStart) / 60000;
      if (dwell > best) { best = dwell; bestZone = curZone; }
    } else {
      curStart = null;
      curZone = null;
    }
  }
  return { minutes: Math.round(best), zone: bestZone };
}

// Range parsing — accepts "1h" | "6h" | "24h" | "7d" | "30d" | "all"
// Returns SQL interval string + bucket size for timeline chart.
function parseRange(raw: string | null): { interval: string; bucketSec: number; label: string } {
  const r = (raw ?? "24h").toLowerCase();
  switch (r) {
    case "1h":   return { interval: "1 hour",   bucketSec: 5 * 60,         label: "1h" };
    case "6h":   return { interval: "6 hours",  bucketSec: 15 * 60,        label: "6h" };
    case "24h":  return { interval: "24 hours", bucketSec: 60 * 60,        label: "24h" };
    case "7d":   return { interval: "7 days",   bucketSec: 6 * 60 * 60,    label: "7d" };
    case "30d":  return { interval: "30 days",  bucketSec: 24 * 60 * 60,   label: "30d" };
    case "all":  return { interval: "90 days",  bucketSec: 24 * 60 * 60,   label: "all" }; // cap at 90d safety
    default:     return { interval: "24 hours", bucketSec: 60 * 60,        label: "24h" };
  }
}

async function handleSanctionedActive(req?: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });

  // Filter param: ?lists=ofac,eu,uk,ru,ua,iran  (any combo, OR-semantics)
  const url = req ? new URL(req.url) : null;
  const listsParam = url?.searchParams.get("lists") ?? "";
  const wantedLists = new Set(listsParam.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const range = parseRange(url?.searchParams.get("range") ?? null);

  const programFilters: string[] = [];
  if (wantedLists.has("ofac"))  programFilters.push("ofac");
  if (wantedLists.has("eu"))    programFilters.push("eu_");
  if (wantedLists.has("uk"))    programFilters.push("gb_fcdo");
  if (wantedLists.has("iran"))  programFilters.push("iran");
  const programLikePatterns = programFilters.map((p) => `%${p}%`);
  // ru/ua use the boolean flag from sanctions aggregation (more inclusive than program-name match)
  const filterRu = wantedLists.has("ru");
  const filterUa = wantedLists.has("ua");

  const rows = await sql`
    WITH latest_positions AS (
      SELECT DISTINCT ON (mmsi)
        mmsi, lat, lon, sog, cog, heading, nav_status, ts
      FROM positions
      WHERE ts > NOW() - ${sql.unsafe("INTERVAL '" + range.interval + "'")}
      ORDER BY mmsi, ts DESC
    ),
    sanction_agg AS (
      SELECT
        imo,
        array_agg(DISTINCT source)                                  AS sources,
        array_agg(DISTINCT split_part(reason, ';', 1)) FILTER (
          WHERE reason IS NOT NULL AND reason <> ''
        )                                                           AS programs,
        BOOL_OR(reason ILIKE '%RUSSIA%' OR reason ILIKE '%UKRAINE%' OR reason ILIKE '%ua_war%') AS russia_ukraine_linked,
        (array_agg(raw->>'flag') FILTER (WHERE raw->>'flag' IS NOT NULL))[1] AS flag
      FROM sanctioned_vessels
      WHERE imo IS NOT NULL
      GROUP BY imo
    ),
    chain_check AS (
      SELECT
        ev.imo,
        BOOL_OR(eo.countries && ${SANCTIONED_COUNTRIES}::text[]) AS chain_has_sanctioned_country
      FROM entities ev
      JOIN entity_relations r ON r.dst_id = ev.id
      JOIN entities eo ON eo.id = r.src_id
      WHERE ev.imo IS NOT NULL AND ev.schema_type = 'Vessel'
      GROUP BY ev.imo
    ),
    ent_meta AS (
      SELECT
        imo,
        CASE WHEN jsonb_typeof(properties->'pastFlags') = 'array'
             THEN jsonb_array_length(properties->'pastFlags') ELSE 0 END AS flag_changes_count,
        properties->'buildDate'->>0 AS build_date
      FROM entities
      WHERE imo IS NOT NULL AND schema_type = 'Vessel'
    )
    SELECT
      v.mmsi::text as mmsi,
      v.imo::text  as imo,
      v.name,
      v.destination,
      v.ship_type,
      sa.sources,
      sa.programs,
      sa.russia_ukraine_linked,
      sa.flag,
      COALESCE(cc.chain_has_sanctioned_country, FALSE) AS chain_has_sanctioned_country,
      COALESCE(em.flag_changes_count, 0) AS flag_changes_count,
      em.build_date,
      lp.lat, lp.lon, lp.sog, lp.cog, lp.heading, lp.nav_status, lp.ts
    FROM vessels v
    JOIN sanction_agg     sa ON v.imo = sa.imo
    JOIN latest_positions lp ON v.mmsi = lp.mmsi
    LEFT JOIN chain_check cc ON cc.imo = v.imo
    LEFT JOIN ent_meta    em ON em.imo = v.imo
    WHERE v.ship_type BETWEEN 80 AND 89
      ${programLikePatterns.length > 0
        ? sql`AND EXISTS (SELECT 1 FROM unnest(sa.programs) p WHERE p ILIKE ANY(${programLikePatterns}::text[]))`
        : sql``}
      ${filterRu || filterUa ? sql`AND sa.russia_ukraine_linked = TRUE` : sql``}
    ORDER BY sa.russia_ukraine_linked DESC, lp.ts DESC
  `;

  // Batch the provenance lookups (PSC + cases) once for all visible IMOs,
  // guarded by table existence so the endpoint works pre-migration.
  const recon = await reconTables();
  const imoList = rows.map((r) => Number(r.imo)).filter((n) => Number.isFinite(n) && n > 0);
  const pscImos = new Set<number>();
  const caseImos = new Set<number>();
  if (imoList.length > 0 && recon.psc) {
    const pr = await sql`
      SELECT DISTINCT imo FROM psc_detentions
      WHERE imo = ANY(${imoList}::bigint[])
        AND detained_on > CURRENT_DATE - INTERVAL '24 months'
    `;
    for (const row of pr) pscImos.add(Number(row.imo));
  }
  if (imoList.length > 0 && recon.cases) {
    const cr = await sql`
      SELECT DISTINCT unnest(imos) AS imo FROM known_cases
      WHERE imos && ${imoList}::bigint[]
    `;
    for (const row of cr) caseImos.add(Number(row.imo));
  }

  // Compute risk score per vessel (track-derived signals are detail-only).
  const now = Date.now();
  const nowYear = new Date().getFullYear();
  const enriched = rows.map((r) => {
    const dark_min = r.ts ? (now - new Date(r.ts as string).getTime()) / 60000 : 0;
    const imoNum = Number(r.imo);
    const inputs: RiskInputs = {
      sanction_count: Array.isArray(r.programs) ? (r.programs as string[]).length : 0,
      russia_ukraine_linked: !!r.russia_ukraine_linked,
      flag_of_convenience: isFlagOfConvenience(r.flag as string | null),
      ais_dark_minutes: dark_min,
      longest_gap_min_24h: 0, // computed only on detail endpoint
      gap_in_suspect_zone_24h: false,
      chain_has_sanctioned_country: !!r.chain_has_sanctioned_country,
      flag_changes_count: Number(r.flag_changes_count) || 0,
      vessel_age_years: vesselAgeYears(r.build_date as string | null, nowYear),
      psc_detained_recently: pscImos.has(imoNum),
      in_known_case: caseImos.has(imoNum),
    };
    const risk = computeRisk(inputs);
    return { ...r, risk_score: risk.score, risk_bucket: risk.bucket };
  });

  // Sort by risk DESC
  enriched.sort((a, b) => b.risk_score - a.risk_score);

  // CSV export support
  if (url?.searchParams.get("format")?.toLowerCase() === "csv") {
    const csvRows = enriched.map((row) => {
      const v = row as unknown as Record<string, unknown>;
      return {
        imo: v.imo,
        mmsi: v.mmsi,
        name: v.name,
        flag: v.flag,
        destination: v.destination,
        ship_type: v.ship_type,
        programs: Array.isArray(v.programs) ? (v.programs as string[]).join("|") : "",
        sources: Array.isArray(v.sources) ? (v.sources as string[]).join("|") : "",
        russia_ukraine_linked: v.russia_ukraine_linked,
        chain_has_sanctioned_country: v.chain_has_sanctioned_country,
        risk_score: v.risk_score,
        risk_bucket: v.risk_bucket,
        lat: v.lat,
        lon: v.lon,
        sog: v.sog,
        cog: v.cog,
        last_seen: v.ts,
      };
    });
    return csvResponse(csvRows as unknown as Array<Record<string, unknown>>, `sanctioned-active-${new Date().toISOString().slice(0,10)}.csv`);
  }
  return jsonResponse({ count: enriched.length, vessels: enriched });
}

async function handleVesselDetail(imoStr: string, req?: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const imo = parseInt(imoStr, 10);
  if (!Number.isFinite(imo) || imo < 1000000 || imo > 9999999) {
    return jsonResponse({ error: "invalid_imo" }, { status: 400 });
  }
  const url = req ? new URL(req.url) : null;
  const range = parseRange(url?.searchParams.get("range") ?? null);

  // Vessel + aggregated sanctions across all sources + FtM property enrichment
  const vesselRows = await sql`
    WITH agg AS (
      SELECT
        imo,
        array_agg(DISTINCT source)                                  AS sources,
        array_agg(DISTINCT split_part(reason, ';', 1)) FILTER (
          WHERE reason IS NOT NULL AND reason <> ''
        )                                                           AS programs,
        BOOL_OR(reason ILIKE '%RUSSIA%' OR reason ILIKE '%UKRAINE%' OR reason ILIKE '%ua_war%') AS russia_ukraine_linked,
        (array_agg(raw))[1] AS sample_raw
      FROM sanctioned_vessels
      WHERE imo = ${imo}
      GROUP BY imo
    ),
    ent AS (
      SELECT
        properties->'buildDate'->>0       AS build_date,
        properties->'type'->>0            AS ftm_type,
        properties->'flag'->>0            AS ftm_flag,
        properties->'tonnage'->>0         AS tonnage,
        properties->'grossRegisteredTonnage'->>0 AS grt,
        properties->'deadweightTons'->>0  AS dwt,
        properties->'pastFlags'           AS past_flags,
        -- All historical names: the FtM "name" array contains current + aliases + previous names
        properties->'name'                AS all_names,
        properties->'notes'               AS notes,
        properties->'topics'              AS topics,
        properties->'callSign'->>0        AS call_sign_ftm,
        countries                         AS ftm_countries,
        url                               AS ftm_url
      FROM entities
      WHERE imo = ${imo} AND schema_type = 'Vessel'
      LIMIT 1
    )
    SELECT
      v.mmsi::text as mmsi,
      v.imo::text  as imo,
      v.name,
      v.call_sign,
      v.ship_type,
      v.destination,
      v.draught,
      v.first_seen,
      v.last_seen,
      agg.sources               AS sanction_sources,
      agg.programs              AS sanction_programs,
      agg.russia_ukraine_linked AS russia_ukraine_linked,
      agg.sample_raw->>'flag'        AS sanction_flag,
      agg.sample_raw->>'owner'       AS sanction_owner,
      agg.sample_raw->>'vesselType'  AS sanction_vessel_type,
      agg.sample_raw->>'url'         AS sanction_url,
      ent.build_date,
      ent.ftm_type,
      ent.ftm_flag,
      ent.tonnage,
      ent.grt,
      ent.dwt,
      ent.past_flags,
      ent.all_names,
      ent.notes,
      ent.topics,
      ent.call_sign_ftm,
      ent.ftm_countries,
      ent.ftm_url
    FROM vessels v
    LEFT JOIN agg ON v.imo = agg.imo
    LEFT JOIN ent ON TRUE
    WHERE v.imo = ${imo}
    LIMIT 1
  `;
  const vessel = vesselRows[0];
  if (!vessel) return jsonResponse({ error: "not_found" }, { status: 404 });

  // mmsi is returned as text from query; convert to number for parameter binding
  const mmsiNum = Number(vessel.mmsi);
  const positions = await sql`
    SELECT lat, lon, sog, cog, heading, nav_status, ts
    FROM positions
    WHERE mmsi = ${mmsiNum}
      AND ts > NOW() - ${sql.unsafe("INTERVAL '" + range.interval + "'")}
    ORDER BY ts ASC
  `;

  // AIS gaps: any consecutive positions >30 min apart in last 24h.
  // Annotate each gap with whether it overlaps a suspect zone (STS / sanctioned port approach).
  type Gap = {
    from_ts: string; to_ts: string;
    duration_min: number;
    from_lat: number; from_lon: number;
    to_lat: number; to_lon: number;
    from_zone: { name: string; category: string } | null;
    to_zone: { name: string; category: string } | null;
    verify_url: string | null;
  };
  const gaps: Gap[] = [];
  for (let i = 1; i < positions.length; i++) {
    const prev = positions[i - 1]!;
    const cur = positions[i]!;
    const dtMs = new Date(cur.ts as string).getTime() - new Date(prev.ts as string).getTime();
    const dtMin = dtMs / 60000;
    if (dtMin > 30) {
      const fromLat = prev.lat as number;
      const fromLon = prev.lon as number;
      const toLat = cur.lat as number;
      const toLon = cur.lon as number;
      const fromZone = findZone(fromLat, fromLon);
      const toZone = findZone(toLat, toLon);
      // Generate Sentinel-1 verify URL only for gaps inside a zone (most useful for researchers)
      const inZone = !!(fromZone || toZone);
      const verifyLat = (fromLat + toLat) / 2;
      const verifyLon = (fromLon + toLon) / 2;
      const verifyUrl = inZone ? sentinelVerifyUrl(verifyLat, verifyLon, prev.ts as string, cur.ts as string) : null;
      gaps.push({
        from_ts: prev.ts as string,
        to_ts: cur.ts as string,
        duration_min: Math.round(dtMin),
        from_lat: fromLat, from_lon: fromLon,
        to_lat: toLat,     to_lon: toLon,
        from_zone: fromZone ? { name: fromZone.name, category: fromZone.category } : null,
        to_zone:   toZone   ? { name: toZone.name,   category: toZone.category }   : null,
        verify_url: verifyUrl,
      });
    }
  }

  const stats = {
    track_points: positions.length,
    track_first_ts: positions[0]?.ts ?? null,
    track_last_ts:  positions[positions.length - 1]?.ts ?? null,
    gap_count: gaps.length,
    longest_gap_min: gaps.reduce((m, g) => Math.max(m, g.duration_min), 0),
    gaps_in_zone: gaps.filter((g) => g.from_zone || g.to_zone).length,
  };

  // Compute full risk score with track-derived signals
  const lastTs = positions[positions.length - 1]?.ts as string | undefined;
  const dark_min = lastTs ? (Date.now() - new Date(lastTs).getTime()) / 60000 : 0;
  const sanction_count = Array.isArray(vessel.sanction_programs) ? (vessel.sanction_programs as string[]).length : 0;

  // Check if ownership chain (1-hop) touches a sanctioned-state owner
  const chainCheck = await sql`
    SELECT EXISTS(
      SELECT 1 FROM entities ev
      JOIN entity_relations r ON r.dst_id = ev.id
      JOIN entities eo ON eo.id = r.src_id
      WHERE ev.imo = ${imo} AND eo.countries && ${SANCTIONED_COUNTRIES}::text[]
    ) AS hit
  `;
  const chainHit = !!(chainCheck[0]?.hit);

  // --- recon signals -------------------------------------------------------
  // Behaviour (from our own AIS track): position spoofing + zone loitering.
  const trackPoints: TrackPoint[] = positions.map((p) => ({
    lat: p.lat as number,
    lon: p.lon as number,
    ts: p.ts as string,
    sog: (p.sog as number | null) ?? null,
  }));
  const spoofJumps = detectSpoofJumps(trackPoints);
  const loiter = detectLoitering(trackPoints);
  const loiteringInZone = loiter.minutes >= 60;

  // Vessel profile (from FtM enrichment already on the row).
  const flagChangesCount = flagHopCount(vessel.past_flags);
  const ageYears = vesselAgeYears(vessel.build_date as string | null, new Date().getFullYear());

  // Provenance (guarded — tables may be absent pre-migration).
  const recon = await reconTables();
  let pscDetentions: Array<Record<string, unknown>> = [];
  let knownCases: Array<Record<string, unknown>> = [];
  if (recon.psc) {
    pscDetentions = await sql`
      SELECT vessel_name, flag, authority, port, detained_on, released_on, deficiencies, detention_days, source_url
      FROM psc_detentions WHERE imo = ${imo}
      ORDER BY detained_on DESC NULLS LAST LIMIT 20
    `;
  }
  if (recon.cases) {
    knownCases = await sql`
      SELECT id, title, summary, source, source_url, published_on, tags
      FROM known_cases WHERE ${imo}::bigint = ANY(imos)
      ORDER BY published_on DESC NULLS LAST LIMIT 20
    `;
  }
  let vesselAttacks: Array<Record<string, unknown>> = [];
  if (recon.attacks) {
    vesselAttacks = await sql`
      SELECT id, occurred_on, vessel_name, attack_type, lat, lon,
             location_precision, summary, source_urls
      FROM tanker_attacks WHERE imo = ${imo}
      ORDER BY occurred_on DESC LIMIT 20
    `;
  }
  // CREA shadow-fleet revenue & insurance signals (guarded — table optional).
  let crea: Record<string, unknown> | null = null;
  if (recon.crea) {
    const creaRows = await sql`
      SELECT imo::text, vessel_name, shadow_fleet, insurer, insurer_country, pi_club,
             price_cap_compliant, voyages, est_revenue_usd::text, main_destination,
             last_voyage_on, source_url
      FROM crea_vessels WHERE imo = ${imo} LIMIT 1
    `;
    crea = creaRows[0] ?? null;
  }
  const pscDetainedRecently = pscDetentions.some((d) => {
    const on = d.detained_on ? new Date(d.detained_on as string).getTime() : 0;
    return on > 0 && (Date.now() - on) / (1000 * 60 * 60 * 24) <= 730; // 24 months
  });

  const risk = computeRisk({
    sanction_count,
    russia_ukraine_linked: !!vessel.russia_ukraine_linked,
    flag_of_convenience: isFlagOfConvenience(vessel.sanction_flag as string | null),
    ais_dark_minutes: dark_min,
    longest_gap_min_24h: stats.longest_gap_min,
    gap_in_suspect_zone_24h: stats.gaps_in_zone > 0,
    chain_has_sanctioned_country: chainHit,
    flag_changes_count: flagChangesCount,
    vessel_age_years: ageYears,
    psc_detained_recently: pscDetainedRecently,
    ais_spoofing_suspected: spoofJumps.length > 0,
    loitering_in_zone: loiteringInZone,
    in_known_case: knownCases.length > 0,
  });

  // Cargo inference + destination decode + external photo / reference links
  const ftmType = vessel.ftm_type as string | null;
  const draughtM = vessel.draught as number | null;
  const cargo = inferCargoType(ftmType);
  const load = inferLoadStatus(ftmType, draughtM);
  const dest = parseDestination(vessel.destination as string | null);
  const links = externalLinks(imo, vessel.name as string | null);

  // Supply chain: if the decoded destination LOCODE matches a curated export
  // terminal, surface that terminal's pipeline→refinery chain. Graceful empty
  // when the links table is absent, no terminal carries the locode, or no link
  // touches it. The terminal `locode` lives in oil_infra.raw (added by the
  // infra research pass), queried via raw->>'locode'.
  let supplyChain: SupplyChain[] = [];
  const destLocode = dest.port?.code ?? dest.destination?.code ?? null;
  if (destLocode && recon.links && recon.infra) {
    // A LOCODE can map to more than one terminal (e.g. Novorossiysk RUNVS covers
    // both Sheskharis and the CPC marine terminal) — union the chains of all that
    // carry it, so a tanker bound there sees every route it could be loading.
    const termRows = await sql`
      SELECT id FROM oil_infra WHERE kind = 'terminal' AND raw->>'locode' = ${destLocode}
    ` as unknown as Array<{ id: string }>;
    const seen = new Set<string>();
    for (const t of termRows) {
      for (const chain of await resolveChainsFor(t.id)) {
        const key = `${chain.pipeline?.id ?? ""}__${chain.terminal?.id ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        supplyChain.push(chain);
      }
    }
  }

  return jsonResponse({
    vessel,
    track: positions,
    gaps,
    stats,
    risk,
    cargo: {
      ...cargo,
      load,
      destination: dest,
    },
    external_links: links,
    // --- recon additions ---
    profile: {
      flag_changes_count: flagChangesCount,
      age_years: ageYears,
    },
    anomalies: {
      spoof_jumps: spoofJumps,
      loitering_minutes: loiter.minutes,
      loitering_zone: loiter.zone,
      loitering_in_zone: loiteringInZone,
    },
    psc: pscDetentions,
    cases: knownCases,
    attacks: vesselAttacks,
    crea,
    supply_chain: supplyChain,
  });
}

async function handleTankersActive(): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const rows = await sql`
    WITH latest_positions AS (
      SELECT DISTINCT ON (mmsi)
        mmsi, lat, lon, sog, cog, heading, ts
      FROM positions
      WHERE ts > NOW() - INTERVAL '6 hours'
      ORDER BY mmsi, ts DESC
    )
    SELECT
      v.mmsi::text as mmsi,
      v.imo::text  as imo,
      v.name,
      v.ship_type,
      lp.lat, lp.lon, lp.sog, lp.cog, lp.heading, lp.ts,
      EXISTS(SELECT 1 FROM sanctioned_vessels s WHERE s.imo = v.imo) AS sanctioned
    FROM vessels v
    JOIN latest_positions lp ON v.mmsi = lp.mmsi
    WHERE v.ship_type BETWEEN 80 AND 89
    ORDER BY lp.ts DESC
    LIMIT 2000
  `;
  return jsonResponse({ count: rows.length, vessels: rows });
}

async function handleStats(): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const [stats] = await sql`
    SELECT
      (SELECT COUNT(*) FROM vessels)                                                              AS vessels_total,
      (SELECT COUNT(*) FROM vessels WHERE ship_type BETWEEN 80 AND 89)                            AS tankers,
      (SELECT COUNT(*) FROM positions)                                                            AS positions,
      (SELECT COUNT(*)                FROM sanctioned_vessels)                                  AS list_total,
      (SELECT COUNT(DISTINCT imo)     FROM sanctioned_vessels WHERE imo IS NOT NULL)             AS list_unique_imos,
      (SELECT COUNT(*)                FROM sanctioned_vessels WHERE source = 'OFAC')             AS list_ofac,
      (SELECT COUNT(*)                FROM sanctioned_vessels WHERE source = 'OpenSanctions')    AS list_opensanctions,
      (SELECT COUNT(DISTINCT imo)     FROM sanctioned_vessels
        WHERE imo IS NOT NULL AND (reason ILIKE '%RUSSIA%' OR reason ILIKE '%UKRAINE%' OR reason ILIKE '%ua_war%')) AS list_russia_ua,
      (SELECT COUNT(DISTINCT v.mmsi) FROM vessels v JOIN sanctioned_vessels s ON v.imo = s.imo
        WHERE v.ship_type BETWEEN 80 AND 89)                                                      AS matched_total,
      (SELECT MAX(ts) FROM positions)                                                             AS last_position_ts
  `;
  return jsonResponse(stats);
}

// Ownership graph traversal — BFS up to maxDepth hops from a vessel root.
// Uses both:
//   (a) entity_relations table (Ownership/Directorship/etc. — explicit FtM relations + synthesized)
//   (b) sanctioned_vessels.imo → entities.imo seed (find OpenSanctions ID for a known IMO)
async function handleVesselOwnership(imoStr: string): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const imo = parseInt(imoStr, 10);
  if (!Number.isFinite(imo)) return jsonResponse({ error: "invalid_imo" }, { status: 400 });

  const MAX_DEPTH = 4;
  const MAX_NODES = 80;

  // Reachable-neighbourhood in ONE round-trip via a recursive CTE (was an
  // iterative BFS issuing up to MAX_DEPTH+1 sequential queries). The CTE walks
  // entity_relations in both directions up to MAX_DEPTH hops from the seed
  // entities for this IMO, keeps each node's MIN depth, and caps at MAX_NODES
  // ordered by depth (closest first). Returns the node set with full details.
  const nodes = await sql`
    WITH RECURSIVE seeds AS (
      SELECT id FROM entities WHERE imo = ${imo} LIMIT 5
    ),
    reach AS (
      SELECT id, 0 AS depth FROM seeds
      UNION
      SELECT CASE WHEN r.src_id = rc.id THEN r.dst_id ELSE r.src_id END, rc.depth + 1
      FROM reach rc
      JOIN entity_relations r ON (r.src_id = rc.id OR r.dst_id = rc.id)
      WHERE rc.depth < ${MAX_DEPTH}
    ),
    node_depth AS (
      SELECT id, MIN(depth) AS depth FROM reach GROUP BY id
    )
    SELECT e.id, nd.depth, e.schema_type, e.caption, e.countries, e.datasets, e.url, e.imo
    FROM node_depth nd
    JOIN entities e ON e.id = nd.id
    ORDER BY nd.depth, e.id
    LIMIT ${MAX_NODES}
  `;

  if (nodes.length === 0) {
    return jsonResponse({ imo, found: false, nodes: [], edges: [] });
  }

  // All relations whose BOTH endpoints are within the node set — the complete
  // induced subgraph (a strict superset of the old BFS, which missed
  // leaf-to-leaf edges at the depth frontier).
  const nodeIds = nodes.map((n) => n.id as string);
  const edges = await sql`
    SELECT id AS rel_id, rel_type, src_id, dst_id, role, percentage, start_date, end_date
    FROM entity_relations
    WHERE src_id = ANY(${nodeIds}::text[]) AND dst_id = ANY(${nodeIds}::text[])
  `;

  const seedCount = nodes.filter((n) => Number(n.depth) === 0).length;
  return jsonResponse({
    imo,
    found: true,
    seed_count: seedCount,
    max_depth_reached: nodes.reduce((m, n) => Math.max(m, Number(n.depth)), 0),
    node_count: nodes.length,
    edge_count: edges.length,
    nodes,
    edges,
  });
}

// Entity (Person / Company / Org) detail + everything it owns/connects to.
// Used for "show all vessels owned by Sovcomflot" type drill-down.
async function handleEntityDetail(entityId: string): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });

  const rows = await sql`
    SELECT id, schema_type, caption, countries, imo, datasets, url, properties
    FROM entities
    WHERE id = ${entityId}
    LIMIT 1
  `;
  const entity = rows[0];
  if (!entity) return jsonResponse({ error: "not_found" }, { status: 404 });

  // Outbound: things this entity owns/directs/etc.
  const owns = await sql`
    SELECT
      e.id, e.schema_type, e.caption, e.countries, e.imo::text as imo, e.url,
      r.rel_type, r.role, r.percentage, r.start_date, r.end_date
    FROM entity_relations r
    JOIN entities e ON e.id = r.dst_id
    WHERE r.src_id = ${entityId}
    LIMIT 200
  `;

  // Inbound: who owns/directs THIS entity
  const ownedBy = await sql`
    SELECT
      e.id, e.schema_type, e.caption, e.countries, e.imo::text as imo, e.url,
      r.rel_type, r.role, r.percentage, r.start_date, r.end_date
    FROM entity_relations r
    JOIN entities e ON e.id = r.src_id
    WHERE r.dst_id = ${entityId}
    LIMIT 200
  `;

  // For owned vessels — also fetch live position (if currently broadcasting)
  const ownedVesselImos = owns
    .filter((o) => o.schema_type === "Vessel" && o.imo)
    .map((o) => Number(o.imo));
  let livePositions: Record<string, { lat: number; lon: number; ts: string }> = {};
  if (ownedVesselImos.length > 0) {
    const live = await sql`
      SELECT v.imo::text as imo, p.lat, p.lon, p.ts
      FROM vessels v
      JOIN LATERAL (
        SELECT lat, lon, ts FROM positions
        WHERE mmsi = v.mmsi AND ts > NOW() - INTERVAL '24 hours'
        ORDER BY ts DESC LIMIT 1
      ) p ON TRUE
      WHERE v.imo = ANY(${ownedVesselImos}::bigint[])
    `;
    for (const row of live) {
      livePositions[String(row.imo)] = {
        lat: row.lat as number,
        lon: row.lon as number,
        ts: row.ts as string,
      };
    }
  }

  // Annotate owned vessels with live status
  const ownedAnnotated = owns.map((o) => {
    if (o.schema_type === "Vessel" && o.imo) {
      const live = livePositions[String(o.imo)];
      return { ...o, live_position: live ?? null, currently_visible: !!live };
    }
    return o;
  });

  return jsonResponse({
    entity,
    owns: ownedAnnotated,
    owns_count: ownedAnnotated.length,
    owned_by: ownedBy,
    owned_by_count: ownedBy.length,
    owned_vessels_live: Object.keys(livePositions).length,
  });
}

async function handleEntitySearch(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return jsonResponse({ count: 0, results: [] });

  const minVessels = parseInt(url.searchParams.get("min_vessels") ?? "0", 10);

  const results = await sql`
    SELECT
      e.id, e.schema_type, e.caption, e.countries, e.imo::text as imo, e.url,
      (SELECT COUNT(*) FROM entity_relations r
        JOIN entities ev ON ev.id = r.dst_id AND ev.schema_type = 'Vessel'
        WHERE r.src_id = e.id) AS vessels_owned
    FROM entities e
    WHERE e.caption ILIKE ${"%" + q + "%"}
      AND e.schema_type IN ('Person', 'Organization', 'Company', 'LegalEntity', 'PublicBody')
    ORDER BY vessels_owned DESC, length(e.caption) ASC
    LIMIT 30
  `;
  const filtered = minVessels > 0 ? results.filter((r) => Number(r.vessels_owned) >= minVessels) : results;

  return jsonResponse({ count: filtered.length, results: filtered });
}

// Aggregate fleet-level analytics: flag distribution, vessel age, top owners,
// zone dwell stats, programme overlaps. Designed for researcher / journalistic use.
async function handleFleetStats(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const url = new URL(req.url);
  const range = parseRange(url.searchParams.get("range") ?? "24h");

  // 1) Flag-of-convenience distribution among currently visible sanctioned vessels.
  const flags = await sql`
    WITH visible AS (
      SELECT DISTINCT v.imo
      FROM positions p
      JOIN vessels v ON v.mmsi = p.mmsi
      WHERE p.ts > NOW() - ${sql.unsafe("INTERVAL '" + range.interval + "'")}
        AND v.ship_type BETWEEN 80 AND 89
        AND EXISTS (SELECT 1 FROM sanctioned_vessels s WHERE s.imo = v.imo)
    )
    SELECT
      LOWER(COALESCE(e.properties->'flag'->>0, e.countries[1], 'unknown')) AS flag,
      COUNT(*) AS vessel_count
    FROM visible v
    JOIN entities e ON e.imo = v.imo AND e.schema_type = 'Vessel'
    GROUP BY flag
    ORDER BY vessel_count DESC
    LIMIT 25
  `;

  // 2) Build-year histogram (decade buckets) of currently visible sanctioned vessels.
  const ages = await sql`
    WITH visible AS (
      SELECT DISTINCT v.imo
      FROM positions p
      JOIN vessels v ON v.mmsi = p.mmsi
      WHERE p.ts > NOW() - ${sql.unsafe("INTERVAL '" + range.interval + "'")}
        AND v.ship_type BETWEEN 80 AND 89
        AND EXISTS (SELECT 1 FROM sanctioned_vessels s WHERE s.imo = v.imo)
    )
    SELECT
      (FLOOR(SUBSTRING(e.properties->'buildDate'->>0 FROM 1 FOR 4)::int / 5) * 5) AS half_decade,
      COUNT(*) AS vessel_count
    FROM visible v
    JOIN entities e ON e.imo = v.imo AND e.schema_type = 'Vessel'
    WHERE e.properties ? 'buildDate'
      AND e.properties->'buildDate'->>0 ~ '^[0-9]{4}'
    GROUP BY half_decade
    ORDER BY half_decade ASC
  `;

  // 3) Top owners by sanctioned-vessel fleet currently visible.
  const topOwners = await sql`
    WITH visible AS (
      SELECT DISTINCT v.imo
      FROM positions p
      JOIN vessels v ON v.mmsi = p.mmsi
      WHERE p.ts > NOW() - ${sql.unsafe("INTERVAL '" + range.interval + "'")}
        AND v.ship_type BETWEEN 80 AND 89
        AND EXISTS (SELECT 1 FROM sanctioned_vessels s WHERE s.imo = v.imo)
    )
    SELECT
      o.id, o.caption, o.schema_type, COALESCE(o.countries[1], 'unknown') AS country,
      COUNT(DISTINCT vv.imo) AS visible_fleet
    FROM visible vv
    JOIN entities ve ON ve.imo = vv.imo AND ve.schema_type = 'Vessel'
    JOIN entity_relations r ON r.dst_id = ve.id
    JOIN entities o ON o.id = r.src_id AND o.schema_type IN ('Company', 'Organization', 'Person', 'LegalEntity', 'PublicBody')
    GROUP BY o.id, o.caption, o.schema_type, o.countries
    HAVING COUNT(DISTINCT vv.imo) > 0
    ORDER BY visible_fleet DESC
    LIMIT 20
  `;

  // 4) Programme-overlap matrix: how many vessels appear on each programme combo.
  const programs = await sql`
    SELECT
      split_part(reason, ';', 1) AS programme,
      COUNT(DISTINCT imo) AS unique_vessels
    FROM sanctioned_vessels
    WHERE imo IS NOT NULL AND reason IS NOT NULL AND reason <> ''
    GROUP BY programme
    ORDER BY unique_vessels DESC
    LIMIT 20
  `;

  // 5) Zone-dwell summary — total dwell minutes per zone in selected range.
  const zoneDwell = await sql`
    WITH ordered AS (
      SELECT
        v.mmsi, v.imo, v.name, p.lat, p.lon, p.ts,
        LAG(p.ts) OVER (PARTITION BY p.mmsi ORDER BY p.ts) AS prev_ts,
        LAG(p.lat) OVER (PARTITION BY p.mmsi ORDER BY p.ts) AS prev_lat,
        LAG(p.lon) OVER (PARTITION BY p.mmsi ORDER BY p.ts) AS prev_lon
      FROM positions p
      JOIN vessels v ON v.mmsi = p.mmsi
      WHERE p.ts > NOW() - ${sql.unsafe("INTERVAL '" + range.interval + "'")}
        AND v.ship_type BETWEEN 80 AND 89
    )
    SELECT mmsi, imo::text AS imo, name, lat, lon, ts, prev_ts
    FROM ordered
    WHERE prev_ts IS NOT NULL
      AND ts - prev_ts < INTERVAL '15 minutes'
  `;

  // Aggregate dwell client-side using zone helper (cheap; dataset small)
  const dwellByZone = new Map<string, { name: string; category: string; vessel_set: Set<number>; total_min: number }>();
  for (const r of zoneDwell) {
    const zone = findZone(r.lat as number, r.lon as number);
    if (!zone) continue;
    const minutes = (new Date(r.ts as string).getTime() - new Date(r.prev_ts as string).getTime()) / 60000;
    const key = zone.name;
    if (!dwellByZone.has(key)) dwellByZone.set(key, { name: zone.name, category: zone.category, vessel_set: new Set(), total_min: 0 });
    const e = dwellByZone.get(key)!;
    e.vessel_set.add(r.mmsi as number);
    e.total_min += minutes;
  }
  const zones = [...dwellByZone.values()]
    .map((e) => ({ name: e.name, category: e.category, vessels: e.vessel_set.size, total_dwell_min: Math.round(e.total_min) }))
    .sort((a, b) => b.total_dwell_min - a.total_dwell_min);

  return jsonResponse({
    range: range.label,
    flags: flags,
    ages: ages,
    top_owners: topOwners,
    programmes: programs,
    zones,
  });
}

// Newly-active vessels: first observed in our feed since N days ago.
// Useful for "what new tonnage appeared this week?" research workflow.
async function handleNewlyActive(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const url = new URL(req.url);
  const sinceDays = parseFloat(url.searchParams.get("since_days") ?? "1");
  const sanctionedOnly = url.searchParams.get("sanctioned") === "true";

  const rows = await sql`
    SELECT
      v.mmsi::text AS mmsi,
      v.imo::text  AS imo,
      v.name,
      v.ship_type,
      v.first_seen,
      v.last_seen,
      EXISTS(SELECT 1 FROM sanctioned_vessels s WHERE s.imo = v.imo) AS sanctioned,
      (SELECT array_agg(DISTINCT split_part(reason, ';', 1))
         FROM sanctioned_vessels WHERE imo = v.imo) AS programs,
      (SELECT lat FROM positions WHERE mmsi = v.mmsi ORDER BY ts DESC LIMIT 1) AS lat,
      (SELECT lon FROM positions WHERE mmsi = v.mmsi ORDER BY ts DESC LIMIT 1) AS lon
    FROM vessels v
    WHERE v.ship_type BETWEEN 80 AND 89
      AND v.first_seen > NOW() - ${sql.unsafe(`INTERVAL '${sinceDays} days'`)}
      ${sanctionedOnly
        ? sql`AND EXISTS (SELECT 1 FROM sanctioned_vessels s WHERE s.imo = v.imo)`
        : sql``}
    ORDER BY v.first_seen DESC
    LIMIT 500
  `;

  return maybeCsvOrJson(
    req,
    rows as unknown as Array<Record<string, unknown>>,
    `newly-active-${sinceDays}d.csv`,
    ["mmsi", "imo", "name", "ship_type", "sanctioned", "programs", "lat", "lon", "first_seen", "last_seen"],
    { since_days: sinceDays, sanctioned_only: sanctionedOnly },
  );
}

// POST batch screening: array of IMOs in body, returns sanction status for each.
// For compliance officers running bulk counterparty checks.
async function handleBatchScreen(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  if (req.method !== "POST") {
    return jsonResponse({ error: "use POST with JSON body { imos: [9000001, 9000002, ...] }" }, { status: 405 });
  }
  let body: { imos?: number[] };
  try {
    body = (await req.json()) as { imos?: number[] };
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400 });
  }
  const imos = (body.imos ?? []).filter((n) => Number.isFinite(n) && n >= 1000000 && n <= 9999999);
  if (imos.length === 0) return jsonResponse({ error: "no valid IMOs (need 7-digit numbers)" }, { status: 400 });
  if (imos.length > 1000) return jsonResponse({ error: "max 1000 IMOs per request" }, { status: 400 });

  const rows = await sql`
    WITH input AS (
      SELECT unnest(${imos}::bigint[]) AS imo
    )
    SELECT
      i.imo::text AS imo,
      sv.imo IS NOT NULL AS is_sanctioned,
      array_agg(DISTINCT sv.source) FILTER (WHERE sv.source IS NOT NULL) AS sources,
      array_agg(DISTINCT split_part(sv.reason, ';', 1)) FILTER (WHERE sv.reason IS NOT NULL) AS programs,
      BOOL_OR(sv.reason ILIKE '%RUSSIA%' OR sv.reason ILIKE '%UKRAINE%' OR sv.reason ILIKE '%ua_war%') AS russia_ukraine_linked,
      e.caption AS opensanctions_caption,
      e.url AS opensanctions_url,
      v.name AS ais_name,
      EXISTS(SELECT 1 FROM positions p WHERE p.mmsi = v.mmsi AND p.ts > NOW() - INTERVAL '24 hours') AS visible_24h
    FROM input i
    LEFT JOIN sanctioned_vessels sv ON sv.imo = i.imo
    LEFT JOIN entities e ON e.imo = i.imo AND e.schema_type = 'Vessel'
    LEFT JOIN vessels v ON v.imo = i.imo
    GROUP BY i.imo, sv.imo, e.caption, e.url, v.name, v.mmsi
    ORDER BY i.imo
  `;

  const url = new URL(req.url);
  if (url.searchParams.get("format")?.toLowerCase() === "csv") {
    return csvResponse(rows as unknown as Array<Record<string, unknown>>,
      `batch-screen-${imos.length}.csv`,
      ["imo", "is_sanctioned", "sources", "programs", "russia_ukraine_linked", "opensanctions_caption", "opensanctions_url", "ais_name", "visible_24h"]);
  }
  return jsonResponse({
    queried: imos.length,
    sanctioned_count: rows.filter((r) => r.is_sanctioned).length,
    russia_ukraine_count: rows.filter((r) => r.russia_ukraine_linked).length,
    visible_24h_count: rows.filter((r) => r.visible_24h).length,
    results: rows,
  });
}

// Owner-fleet activity timeline: for a given owner entity, return time-series of
// how many of their vessels were broadcasting AIS per hour over a range.
async function handleOwnerFleetActivity(entityId: string, req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const url = new URL(req.url);
  const range = parseRange(url.searchParams.get("range") ?? "7d");

  // Find vessels owned by this entity
  const owned = await sql`
    SELECT DISTINCT v.imo, v.caption AS name, v.mmsi
    FROM entity_relations r
    JOIN entities v ON v.id = r.dst_id AND v.schema_type = 'Vessel'
    LEFT JOIN entities x ON x.imo = v.imo
    WHERE r.src_id = ${entityId}
  `;
  if (owned.length === 0) return jsonResponse({ entity_id: entityId, vessel_count: 0, buckets: [] });

  const imos = owned.map((o) => Number(o.imo)).filter((i) => Number.isFinite(i) && i > 0);
  if (imos.length === 0) return jsonResponse({ entity_id: entityId, vessel_count: 0, buckets: [] });

  const buckets = await sql`
    SELECT
      time_bucket(${sql.unsafe(`INTERVAL '${range.bucketSec} seconds'`)}, p.ts) AS bucket,
      COUNT(DISTINCT p.mmsi) AS vessels_active
    FROM positions p
    JOIN vessels v ON v.mmsi = p.mmsi
    WHERE p.ts > NOW() - ${sql.unsafe("INTERVAL '" + range.interval + "'")}
      AND v.imo = ANY(${imos}::bigint[])
    GROUP BY bucket
    ORDER BY bucket ASC
  `;

  return jsonResponse({
    entity_id: entityId,
    range: range.label,
    bucket_seconds: range.bucketSec,
    vessel_count: imos.length,
    buckets: buckets.map((b) => ({ ts: b.bucket, vessels_active: Number(b.vessels_active) })),
  });
}

// Newly-listed sanctions: vessels added to OpenSanctions FtM in last N days.
// Uses entities.properties->'createdAt' (OS-side first-seen). Proxy for
// "newly designated" without needing our own daily snapshots.
async function handleNewlyListed(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const url = new URL(req.url);
  const days = parseFloat(url.searchParams.get("since_days") ?? "180");
  const ruOnly = url.searchParams.get("ru") === "true";

  const rows = await sql`
    WITH listing AS (
      SELECT
        e.id,
        e.imo,
        e.caption,
        e.countries,
        e.url,
        (e.properties->'createdAt'->>0)::date     AS listed_at,
        e.properties->'flag'->>0                  AS flag,
        e.properties->'type'->>0                  AS vessel_type,
        e.properties->'topics'                    AS topics,
        e.properties->'name'                      AS aliases
      FROM entities e
      WHERE e.schema_type = 'Vessel'
        AND e.imo IS NOT NULL
        AND e.properties ? 'createdAt'
        AND (e.properties->'createdAt'->>0) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        AND (e.properties->'createdAt'->>0)::date > CURRENT_DATE - ${sql.unsafe(`INTERVAL '${days} days'`)}
    )
    SELECT
      l.imo::text AS imo,
      l.caption,
      l.countries[1] AS country,
      l.flag,
      l.vessel_type,
      l.url,
      l.listed_at,
      l.aliases,
      l.topics,
      array_agg(DISTINCT s.source) FILTER (WHERE s.source IS NOT NULL) AS sources,
      array_agg(DISTINCT split_part(s.reason, ';', 1)) FILTER (WHERE s.reason IS NOT NULL) AS programs,
      BOOL_OR(s.reason ILIKE '%RUSSIA%' OR s.reason ILIKE '%UKRAINE%' OR s.reason ILIKE '%ua_war%') AS russia_ukraine_linked,
      EXISTS(SELECT 1 FROM vessels vv WHERE vv.imo = l.imo) AS in_our_ais_feed,
      EXISTS(SELECT 1 FROM vessels vv JOIN positions p ON p.mmsi = vv.mmsi
        WHERE vv.imo = l.imo AND p.ts > NOW() - INTERVAL '24 hours') AS visible_24h
    FROM listing l
    LEFT JOIN sanctioned_vessels s ON s.imo = l.imo
    GROUP BY l.id, l.imo, l.caption, l.countries, l.flag, l.vessel_type, l.url, l.listed_at, l.aliases, l.topics
    ${ruOnly ? sql`HAVING BOOL_OR(s.reason ILIKE '%RUSSIA%' OR s.reason ILIKE '%UKRAINE%' OR s.reason ILIKE '%ua_war%') = TRUE` : sql``}
    ORDER BY l.listed_at DESC, l.caption
    LIMIT 500
  `;

  if (url.searchParams.get("format")?.toLowerCase() === "csv") {
    return csvResponse(rows as unknown as Array<Record<string, unknown>>,
      `newly-listed-${days}d.csv`,
      ["listed_at", "imo", "caption", "country", "flag", "vessel_type", "russia_ukraine_linked", "in_our_ais_feed", "visible_24h", "sources", "programs", "url"]);
  }
  return jsonResponse({
    since_days: days,
    count: rows.length,
    russia_ukraine_count: rows.filter((r) => r.russia_ukraine_linked).length,
    in_feed_count: rows.filter((r) => r.in_our_ais_feed).length,
    visible_24h_count: rows.filter((r) => r.visible_24h).length,
    results: rows,
  });
}

// Wikidata SPARQL: lookup vessel by IMO → Wikipedia article URL + Wikimedia Commons image.
// Cache in-memory (1h TTL) to avoid hammering Wikidata.
const wikiCache = new Map<string, { ts: number; data: Record<string, unknown> }>();
const WIKI_CACHE_TTL_MS = 60 * 60 * 1000;

async function handleVesselWiki(imoStr: string): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const imo = parseInt(imoStr, 10);
  if (!Number.isFinite(imo)) return jsonResponse({ error: "invalid_imo" }, { status: 400 });

  const cached = wikiCache.get(imoStr);
  if (cached && Date.now() - cached.ts < WIKI_CACHE_TTL_MS) {
    return jsonResponse({ ...cached.data, cached: true });
  }

  // P458 = IMO ship number; P18 = image; P31 = instance of; sitelink to enwiki
  const sparql = `
    SELECT ?vessel ?vesselLabel ?article ?image ?builtYear ?countryLabel WHERE {
      ?vessel wdt:P458 "${imo}" .
      OPTIONAL { ?article schema:about ?vessel ; schema:isPartOf <https://en.wikipedia.org/> }
      OPTIONAL { ?vessel wdt:P18 ?image }
      OPTIONAL { ?vessel wdt:P729 ?builtYear }
      OPTIONAL { ?vessel wdt:P17 ?country }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
    } LIMIT 1
  `;
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}&format=json`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "oilfront/0.1 (research; non-commercial)" },
    });
    if (!res.ok) {
      logger.warn({ event: "wikidata_error", status: res.status, imo }, "Wikidata fetch failed");
      const out = { imo, found: false };
      wikiCache.set(imoStr, { ts: Date.now(), data: out });
      return jsonResponse(out);
    }
    const data = await res.json() as { results?: { bindings?: Array<Record<string, { value: string }>> } };
    const binding = data.results?.bindings?.[0];
    if (!binding) {
      const out = { imo, found: false };
      wikiCache.set(imoStr, { ts: Date.now(), data: out });
      return jsonResponse(out);
    }
    const out = {
      imo,
      found: true,
      wikidata_id: binding.vessel?.value,
      label: binding.vesselLabel?.value,
      wikipedia_url: binding.article?.value,
      image_url: binding.image?.value,
      built_year: binding.builtYear?.value,
      country: binding.countryLabel?.value,
    };
    wikiCache.set(imoStr, { ts: Date.now(), data: out });
    return jsonResponse(out);
  } catch (err) {
    logger.warn({ event: "wikidata_exception", err: String(err), imo }, "Wikidata exception");
    const out = { imo, found: false, error: "fetch_failed" };
    return jsonResponse(out);
  }
}

// Bulk filter combining multiple criteria — researcher swiss-army-knife.
// Query params:
//   ?min_risk=60          — minimum risk score
//   ?in_zone=true         — only vessels currently in a suspect zone
//   ?dark_min=120         — only vessels AIS-dark for >N minutes
//   ?russia=true          — Russia/Ukraine linked only
//   ?flag_of_convenience=true
//   ?lists=ofac,eu,uk     — programme filter
//   ?format=csv
async function handleAdvancedFilter(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const url = new URL(req.url);
  const minRisk = parseInt(url.searchParams.get("min_risk") ?? "0", 10);
  const inZone = url.searchParams.get("in_zone") === "true";
  const darkMin = parseInt(url.searchParams.get("dark_min") ?? "0", 10);
  const ruOnly = url.searchParams.get("russia") === "true";
  const focOnly = url.searchParams.get("flag_of_convenience") === "true";

  // Reuse handleSanctionedActive logic — fetch all visible sanctioned with risk
  const baseRes = await handleSanctionedActive(req);
  const baseData = await baseRes.json() as { vessels: Array<Record<string, unknown>> };
  let vessels = baseData.vessels;

  // Apply filters client-side (small dataset, easier than building dynamic SQL)
  if (minRisk > 0) vessels = vessels.filter((v) => Number(v.risk_score) >= minRisk);
  if (ruOnly)      vessels = vessels.filter((v) => v.russia_ukraine_linked);
  if (focOnly) {
    const FOC = new Set(["pa","lr","mh","cy","mt","bs","bz","kh","km","ck","ga","hn","mu","pw","st","tg","vu","sl","bb"]);
    vessels = vessels.filter((v) => FOC.has(String(v.flag ?? "").toLowerCase()));
  }
  if (darkMin > 0) {
    const now = Date.now();
    vessels = vessels.filter((v) => {
      const last = v.ts ? new Date(v.ts as string).getTime() : 0;
      return (now - last) / 60000 >= darkMin;
    });
  }
  if (inZone) {
    vessels = vessels.filter((v) => {
      const lat = Number(v.lat), lon = Number(v.lon);
      return Number.isFinite(lat) && Number.isFinite(lon) && findZone(lat, lon) !== null;
    });
  }

  // Annotate with current zone
  const annotated = vessels.map((v) => {
    const lat = Number(v.lat), lon = Number(v.lon);
    const zone = (Number.isFinite(lat) && Number.isFinite(lon)) ? findZone(lat, lon) : null;
    return { ...v, current_zone: zone ? zone.name : null, current_zone_category: zone ? zone.category : null };
  });

  if (url.searchParams.get("format")?.toLowerCase() === "csv") {
    return csvResponse(annotated as unknown as Array<Record<string, unknown>>,
      `advanced-filter-${new Date().toISOString().slice(0,10)}.csv`);
  }
  return jsonResponse({
    filters: { min_risk: minRisk, in_zone: inZone, dark_min: darkMin, russia: ruOnly, flag_of_convenience: focOnly },
    count: annotated.length,
    results: annotated,
  });
}

// GDELT 2.0 news search — vessel name → recent articles.
// In-memory cache with 1h TTL to avoid rate limits.
interface NewsCacheEntry {
  ts: number;
  articles: Array<Record<string, unknown>>;
  query: string;
}
const newsCache = new Map<string, NewsCacheEntry>();
const NEWS_CACHE_TTL_MS = 60 * 60 * 1000;

async function handleVesselNews(imoStr: string): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const imo = parseInt(imoStr, 10);
  if (!Number.isFinite(imo)) return jsonResponse({ error: "invalid_imo" }, { status: 400 });

  const rows = await sql`SELECT name FROM vessels WHERE imo = ${imo} LIMIT 1`;
  const v = rows[0];
  const name = v?.name as string | null;
  if (!name) return jsonResponse({ articles: [], count: 0, note: "no vessel name" });

  // Cache by IMO+name
  const cacheKey = `${imo}_${name}`;
  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NEWS_CACHE_TTL_MS) {
    return jsonResponse({ articles: cached.articles, count: cached.articles.length, query: cached.query, cached: true, cache_age_min: Math.round((Date.now() - cached.ts) / 60000) });
  }

  // GDELT 2.0 Doc API — search vessel name with maritime context terms
  const query = `"${name}" (tanker OR vessel OR sanctions OR shadow OR oil)`;
  const params = new URLSearchParams({
    query,
    format: "json",
    mode: "artlist",
    timespan: "3months",
    maxrecords: "25",
    sort: "datedesc",
  });
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      logger.warn({ event: "gdelt_error", status: res.status, name }, "GDELT fetch failed");
      // Fall back to stale cache if any
      if (cached) return jsonResponse({ articles: cached.articles, count: cached.articles.length, stale: true });
      return jsonResponse({ articles: [], count: 0, error: `gdelt ${res.status}` });
    }
    const text = await res.text();
    let data: { articles?: Array<Record<string, unknown>> } = {};
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      // GDELT sometimes returns HTML error pages — treat as empty
      logger.warn({ event: "gdelt_non_json", name, sample: text.slice(0, 80) }, "GDELT returned non-JSON");
      newsCache.set(cacheKey, { ts: Date.now(), articles: [], query });
      return jsonResponse({ articles: [], count: 0, query, parse_error: true });
    }
    const articles = (data.articles ?? []).map((a) => ({
      title:    a.title,
      url:      a.url,
      domain:   a.domain,
      seendate: a.seendate,
      language: a.language,
      country:  a.sourcecountry,
      tone:     parseFloat(String(a.tone ?? "0")),
    }));
    newsCache.set(cacheKey, { ts: Date.now(), articles, query });
    return jsonResponse({ articles, count: articles.length, query });
  } catch (err) {
    logger.warn({ event: "gdelt_exception", err: String(err), name }, "GDELT fetch threw");
    if (cached) return jsonResponse({ articles: cached.articles, count: cached.articles.length, stale: true });
    return jsonResponse({ articles: [], count: 0, error: "fetch_failed" });
  }
}

// Port-call / zone-visit inference for a vessel.
// Walks vessel's full position history; groups consecutive positions inside the
// same zone into a "visit". Each visit has start/end timestamps, duration,
// position count, speed range. Useful for spotting "vessel X loaded at Tuapse,
// went dark for 12h, reappeared in Lakonikos Bay STS zone" patterns.
async function handleVesselPortCalls(imoStr: string): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const imo = parseInt(imoStr, 10);
  if (!Number.isFinite(imo)) return jsonResponse({ error: "invalid_imo" }, { status: 400 });

  const rows = await sql`
    SELECT p.lat, p.lon, p.sog, p.ts
    FROM positions p
    JOIN vessels v ON v.mmsi = p.mmsi
    WHERE v.imo = ${imo}
    ORDER BY p.ts ASC
  `;

  interface Visit {
    zone_name: string;
    zone_category: string;
    start_ts: string;
    end_ts: string;
    duration_min: number;
    position_count: number;
    min_sog: number;
    max_sog: number;
    avg_lat: number;
    avg_lon: number;
  }

  const visits: Visit[] = [];
  let cur: (Visit & { sum_lat: number; sum_lon: number }) | null = null;

  for (const r of rows) {
    const lat = r.lat as number;
    const lon = r.lon as number;
    const sog = r.sog as number | null;
    const ts = r.ts as string;
    // Check both suspect zones AND world commercial ports for broader port-call detection.
    const zone = findZone(lat, lon);
    const nearestPort = findNearestPort(lat, lon, 10);
    // Prefer suspect zone label when present (curated, more specific); else fall back to nearest port.
    const matched = zone
      ? { name: zone.name, category: zone.category }
      : (nearestPort ? { name: nearestPort.name + " (" + nearestPort.country + ")", category: nearestPort.role } : null);

    if (matched) {
      if (cur && cur.zone_name === matched.name) {
        cur.end_ts = ts;
        cur.position_count++;
        cur.sum_lat += lat;
        cur.sum_lon += lon;
        if (sog !== null) {
          cur.min_sog = Math.min(cur.min_sog, sog);
          cur.max_sog = Math.max(cur.max_sog, sog);
        }
      } else {
        if (cur) {
          cur.duration_min = Math.round((new Date(cur.end_ts).getTime() - new Date(cur.start_ts).getTime()) / 60000);
          cur.avg_lat = cur.sum_lat / cur.position_count;
          cur.avg_lon = cur.sum_lon / cur.position_count;
          visits.push(cur);
        }
        cur = {
          zone_name: matched.name,
          zone_category: matched.category,
          start_ts: ts,
          end_ts: ts,
          duration_min: 0,
          position_count: 1,
          min_sog: sog ?? 0,
          max_sog: sog ?? 0,
          avg_lat: lat,
          avg_lon: lon,
          sum_lat: lat,
          sum_lon: lon,
        };
      }
    } else if (cur) {
      cur.duration_min = Math.round((new Date(cur.end_ts).getTime() - new Date(cur.start_ts).getTime()) / 60000);
      cur.avg_lat = cur.sum_lat / cur.position_count;
      cur.avg_lon = cur.sum_lon / cur.position_count;
      visits.push(cur);
      cur = null;
    }
  }
  if (cur) {
    cur.duration_min = Math.round((new Date(cur.end_ts).getTime() - new Date(cur.start_ts).getTime()) / 60000);
    cur.avg_lat = cur.sum_lat / cur.position_count;
    cur.avg_lon = cur.sum_lon / cur.position_count;
    visits.push(cur);
  }

  // Strip the rolling-sum scratch fields from output
  const out = visits.map((v) => {
    const r = v as unknown as Record<string, unknown>;
    const { sum_lat: _l, sum_lon: _o, ...rest } = r;
    return rest;
  });

  return jsonResponse({ imo, count: out.length, visits: out });
}

// STS event clustering: groups proximity-candidate observations into discrete
// time-bounded events. Each event = a (vessel pair) seen close together for a
// continuous period. Skipping >30min gap = new event.
async function handleStsEvents(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const url = new URL(req.url);
  const range = parseRange(url.searchParams.get("range") ?? "24h");
  const maxNm = parseFloat(url.searchParams.get("max_nm") ?? "1.5");
  const maxKn = parseFloat(url.searchParams.get("max_kn") ?? "2.0");
  const minDurationMin = parseFloat(url.searchParams.get("min_duration_min") ?? "10");

  const obs = await sql`
    WITH sanc_imos AS (
      SELECT DISTINCT imo FROM sanctioned_vessels WHERE imo IS NOT NULL
    ),
    recent AS (
      -- Downsample to one position per vessel per 3-min window: STS events span
      -- 10+ min, so this preserves detection while cutting the join input by an
      -- order of magnitude. Sanctioned status is resolved once here (a single
      -- join), not per candidate pair.
      SELECT DISTINCT ON (p.mmsi, time_bucket(INTERVAL '180 seconds', p.ts))
        p.mmsi, p.lat, p.lon, COALESCE(p.sog, 0) AS sog, p.ts,
        v.imo, v.name,
        (si.imo IS NOT NULL) AS is_sanc,
        -- 0.1° (~6 nm) spatial grid cell — the join key that prunes the pair-space
        floor(p.lat / 0.1)::int AS gx, floor(p.lon / 0.1)::int AS gy
      FROM positions p
      JOIN vessels v ON v.mmsi = p.mmsi
      LEFT JOIN sanc_imos si ON si.imo = v.imo
      WHERE p.ts > NOW() - ${sql.unsafe("INTERVAL '" + range.interval + "'")}
        AND v.ship_type BETWEEN 80 AND 89
        AND COALESCE(p.sog, 0) < ${maxKn}
      ORDER BY p.mmsi, time_bucket(INTERVAL '180 seconds', p.ts), p.ts DESC
    ),
    -- Expand each "a" row to its 3×3 cell neighbourhood so the join becomes a
    -- hash join on (cell) instead of a global cartesian product. A pair within
    -- max_nm (≤2 nm) is always in the same or an adjacent 0.1° cell, so this is
    -- exact, not approximate — vessels in different regions are never compared.
    recent_cells AS (
      SELECT r.*, r.gx + dx AS cx, r.gy + dy AS cy
      FROM recent r
      CROSS JOIN (VALUES (-1),(0),(1)) AS ox(dx)
      CROSS JOIN (VALUES (-1),(0),(1)) AS oy(dy)
    )
    SELECT
      a.mmsi AS mmsi_a, a.imo::text AS imo_a, a.name AS name_a, a.lat AS lat_a, a.lon AS lon_a, a.sog AS sog_a, a.ts AS ts_a,
      b.mmsi AS mmsi_b, b.imo::text AS imo_b, b.name AS name_b, b.lat AS lat_b, b.lon AS lon_b, b.sog AS sog_b,
      111.12 * 0.539957 * sqrt(
        power(a.lat - b.lat, 2) +
        power((a.lon - b.lon) * cos(radians((a.lat + b.lat) / 2.0)), 2)
      ) AS distance_nm,
      a.is_sanc AS sanc_a,
      b.is_sanc AS sanc_b
    FROM recent_cells a
    JOIN recent b ON b.gx = a.cx AND b.gy = a.cy
      AND a.mmsi < b.mmsi
      AND ABS(EXTRACT(EPOCH FROM (a.ts - b.ts))) < 300
      -- Only rendezvous involving at least one sanctioned vessel matter here;
      -- this also prunes the dense clean-anchorage noise (Singapore, Fujairah).
      AND (a.is_sanc OR b.is_sanc)
    WHERE 111.12 * 0.539957 * sqrt(
            power(a.lat - b.lat, 2) +
            power((a.lon - b.lon) * cos(radians((a.lat + b.lat) / 2.0)), 2)
          ) < ${maxNm}
    ORDER BY a.mmsi, b.mmsi, a.ts
  `;

  // Group by pair, then split into events on >30min gap
  interface EventBucket {
    mmsi_a: number; mmsi_b: number;
    imo_a: string | null; imo_b: string | null;
    name_a: string; name_b: string;
    sanc_a: boolean; sanc_b: boolean;
    start_ts: string; end_ts: string;
    duration_min: number;
    observation_count: number;
    min_distance_nm: number;
    avg_lat: number; avg_lon: number;
    zone_name: string | null;
    zone_category: string | null;
  }

  const events: EventBucket[] = [];
  type Obs = (typeof obs)[number];
  const byPair = new Map<string, Obs[]>();
  for (const o of obs) {
    const key = `${o.mmsi_a}_${o.mmsi_b}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(o);
  }

  for (const [, list] of byPair) {
    let cur: EventBucket | null = null;
    let sumLat = 0, sumLon = 0;
    for (const o of list) {
      const t = new Date(o.ts_a as string).getTime();
      const midLat = ((o.lat_a as number) + (o.lat_b as number)) / 2;
      const midLon = ((o.lon_a as number) + (o.lon_b as number)) / 2;
      if (cur && t - new Date(cur.end_ts).getTime() < 30 * 60 * 1000) {
        cur.end_ts = o.ts_a as string;
        cur.observation_count++;
        cur.min_distance_nm = Math.min(cur.min_distance_nm, o.distance_nm as number);
        sumLat += midLat;
        sumLon += midLon;
        cur.avg_lat = sumLat / cur.observation_count;
        cur.avg_lon = sumLon / cur.observation_count;
      } else {
        if (cur) {
          cur.duration_min = Math.round((new Date(cur.end_ts).getTime() - new Date(cur.start_ts).getTime()) / 60000);
          const z = findZone(cur.avg_lat, cur.avg_lon);
          cur.zone_name = z?.name ?? null;
          cur.zone_category = z?.category ?? null;
          if (cur.duration_min >= minDurationMin) events.push(cur);
        }
        sumLat = midLat; sumLon = midLon;
        cur = {
          mmsi_a: o.mmsi_a as number,
          mmsi_b: o.mmsi_b as number,
          imo_a: o.imo_a as string | null,
          imo_b: o.imo_b as string | null,
          name_a: o.name_a as string,
          name_b: o.name_b as string,
          sanc_a: !!o.sanc_a,
          sanc_b: !!o.sanc_b,
          start_ts: o.ts_a as string,
          end_ts: o.ts_a as string,
          duration_min: 0,
          observation_count: 1,
          min_distance_nm: o.distance_nm as number,
          avg_lat: midLat,
          avg_lon: midLon,
          zone_name: null,
          zone_category: null,
        };
      }
    }
    if (cur) {
      cur.duration_min = Math.round((new Date(cur.end_ts).getTime() - new Date(cur.start_ts).getTime()) / 60000);
      const z = findZone(cur.avg_lat, cur.avg_lon);
      cur.zone_name = z?.name ?? null;
      cur.zone_category = z?.category ?? null;
      if (cur.duration_min >= minDurationMin) events.push(cur);
    }
  }

  // Sort: ongoing/most-recent first, both-sanctioned bonus
  events.sort((a, b) => {
    const aBoth = (a.sanc_a && a.sanc_b) ? 1 : 0;
    const bBoth = (b.sanc_a && b.sanc_b) ? 1 : 0;
    if (aBoth !== bBoth) return bBoth - aBoth;
    return new Date(b.end_ts).getTime() - new Date(a.end_ts).getTime();
  });

  if (url.searchParams.get("format")?.toLowerCase() === "csv") {
    return csvResponse(events as unknown as Array<Record<string, unknown>>,
      `sts-events-${range.label}-${new Date().toISOString().slice(0,10)}.csv`,
      ["start_ts", "end_ts", "duration_min", "name_a", "imo_a", "sanc_a", "name_b", "imo_b", "sanc_b", "min_distance_nm", "observation_count", "zone_name", "zone_category", "avg_lat", "avg_lon"]);
  }

  return jsonResponse({
    range: range.label,
    count: events.length,
    in_zone_count: events.filter((e) => e.zone_name).length,
    both_sanctioned_count: events.filter((e) => e.sanc_a && e.sanc_b).length,
    events,
  });
}

// STS (Ship-to-Ship transfer) candidate detector.
// Finds pairs of tankers that are:
//   * within 1.5 nm of each other
//   * both moving < 2 knots
//   * positions within 5 min of each other
//   * at least one is on a sanctions list
// Returns recent candidate "rendezvous" pairs. Shadow-fleet textbook pattern.
async function handleStsCandidates(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const url = new URL(req.url);
  const range = parseRange(url.searchParams.get("range") ?? "6h");
  const maxNm = parseFloat(url.searchParams.get("max_nm") ?? "1.5");
  const maxKn = parseFloat(url.searchParams.get("max_kn") ?? "2.0");

  const rows = await sql`
    WITH sanc_imos AS (
      SELECT DISTINCT imo FROM sanctioned_vessels WHERE imo IS NOT NULL
    ),
    recent AS (
      -- One position per vessel per 3-min window + sanctioned status resolved
      -- once + 0.1° grid cell (see handleStsEvents for the rationale).
      SELECT DISTINCT ON (p.mmsi, time_bucket(INTERVAL '180 seconds', p.ts))
        p.mmsi, p.lat, p.lon, COALESCE(p.sog, 0) AS sog, p.ts,
        v.imo, v.name, v.ship_type,
        (si.imo IS NOT NULL) AS is_sanc,
        floor(p.lat / 0.1)::int AS gx, floor(p.lon / 0.1)::int AS gy
      FROM positions p
      JOIN vessels v ON v.mmsi = p.mmsi
      LEFT JOIN sanc_imos si ON si.imo = v.imo
      WHERE p.ts > NOW() - ${sql.unsafe("INTERVAL '" + range.interval + "'")}
        AND v.ship_type BETWEEN 80 AND 89
        AND COALESCE(p.sog, 0) < ${maxKn}
      ORDER BY p.mmsi, time_bucket(INTERVAL '180 seconds', p.ts), p.ts DESC
    ),
    recent_cells AS (
      SELECT r.*, r.gx + dx AS cx, r.gy + dy AS cy
      FROM recent r
      CROSS JOIN (VALUES (-1),(0),(1)) AS ox(dx)
      CROSS JOIN (VALUES (-1),(0),(1)) AS oy(dy)
    ),
    pairs AS (
      SELECT
        a.mmsi AS mmsi_a, a.imo::text AS imo_a, a.name AS name_a, a.lat AS lat_a, a.lon AS lon_a, a.sog AS sog_a, a.ts AS ts_a, a.is_sanc AS sanc_a,
        b.mmsi AS mmsi_b, b.imo::text AS imo_b, b.name AS name_b, b.lat AS lat_b, b.lon AS lon_b, b.sog AS sog_b, b.ts AS ts_b, b.is_sanc AS sanc_b,
        -- simplified equirectangular distance in nm (good enough at <50nm)
        111.12 * 0.539957 * sqrt(
          power(a.lat - b.lat, 2) +
          power((a.lon - b.lon) * cos(radians((a.lat + b.lat) / 2.0)), 2)
        ) AS distance_nm,
        ABS(EXTRACT(EPOCH FROM (a.ts - b.ts))) AS seconds_apart
      FROM recent_cells a
      JOIN recent b ON b.gx = a.cx AND b.gy = a.cy
        AND a.mmsi < b.mmsi
        AND ABS(EXTRACT(EPOCH FROM (a.ts - b.ts))) < 300
    ),
    proximate AS (
      SELECT * FROM pairs
      WHERE distance_nm < ${maxNm}
    ),
    annotated AS (
      SELECT * FROM proximate
    ),
    deduped AS (
      -- Keep only the most recent observation per vessel pair
      SELECT DISTINCT ON (mmsi_a, mmsi_b) *
      FROM annotated
      WHERE sanc_a = TRUE OR sanc_b = TRUE
      ORDER BY mmsi_a, mmsi_b, ts_a DESC
    )
    SELECT * FROM deduped
    ORDER BY (sanc_a AND sanc_b) DESC, ts_a DESC
    LIMIT 60
  `;

  // Annotate with zone (midpoint check)
  const annotated = rows.map((r) => {
    const lat = ((r.lat_a as number) + (r.lat_b as number)) / 2;
    const lon = ((r.lon_a as number) + (r.lon_b as number)) / 2;
    const zone = findZone(lat, lon);
    const bothSanctioned = !!r.sanc_a && !!r.sanc_b;
    return {
      ...r,
      midpoint_lat: lat,
      midpoint_lon: lon,
      zone: zone ? { name: zone.name, category: zone.category } : null,
      both_sanctioned: bothSanctioned,
    };
  });

  return jsonResponse({
    range: range.label,
    count: annotated.length,
    in_zone_count: annotated.filter((a) => a.zone).length,
    both_sanctioned_count: annotated.filter((a) => a.both_sanctioned).length,
    pairs: annotated,
  });
}

// Activity timeline: distinct sanctioned vessels visible per time bucket.
// Used by the activity strip below the map.
async function handleTimeline(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const url = new URL(req.url);
  const range = parseRange(url.searchParams.get("range"));
  const listsParam = url.searchParams.get("lists") ?? "";
  const wantedLists = new Set(listsParam.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const filterRu = wantedLists.has("ru") || wantedLists.has("ua");

  const rows = await sql`
    WITH bucketed AS (
      SELECT
        time_bucket(${sql.unsafe(`INTERVAL '${range.bucketSec} seconds'`)}, p.ts) AS bucket,
        v.mmsi,
        v.imo
      FROM positions p
      JOIN vessels v ON v.mmsi = p.mmsi
      WHERE p.ts > NOW() - ${sql.unsafe("INTERVAL '" + range.interval + "'")}
        AND v.ship_type BETWEEN 80 AND 89
    ),
    sanc_agg AS (
      SELECT DISTINCT
        imo,
        BOOL_OR(reason ILIKE '%RUSSIA%' OR reason ILIKE '%UKRAINE%' OR reason ILIKE '%ua_war%')
          OVER (PARTITION BY imo) AS ru_ua_linked
      FROM sanctioned_vessels
      WHERE imo IS NOT NULL
    )
    SELECT
      b.bucket,
      COUNT(DISTINCT b.mmsi) FILTER (WHERE s.imo IS NOT NULL)                                               AS sanctioned,
      COUNT(DISTINCT b.mmsi) FILTER (WHERE s.imo IS NOT NULL AND s.ru_ua_linked)                            AS ru_ua,
      COUNT(DISTINCT b.mmsi)                                                                                AS total_tankers
    FROM bucketed b
    LEFT JOIN sanc_agg s ON s.imo = b.imo
    GROUP BY b.bucket
    ORDER BY b.bucket ASC
  `;

  // For ru/ua filter: only return ru_ua counts as "primary" series
  const primaryKey = filterRu ? "ru_ua" : "sanctioned";
  return jsonResponse({
    range: range.label,
    bucket_seconds: range.bucketSec,
    primary_key: primaryKey,
    buckets: rows.map((r) => ({
      ts: r.bucket,
      sanctioned: Number(r.sanctioned),
      ru_ua: Number(r.ru_ua),
      total_tankers: Number(r.total_tankers),
    })),
  });
}

async function handleZones(): Promise<Response> {
  return jsonResponse({ count: SUSPECT_ZONES.length, zones: SUSPECT_ZONES });
}

// Documented investigative cases (KSE / CREA / UANI / OCCRP seed).
// Optional filters: ?source=KSE  ?tag=sts  ?imo=9999990  ?format=csv
async function handleCases(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const recon = await reconTables();
  if (!recon.cases) {
    return jsonResponse({ count: 0, results: [], note: "known_cases table absent — run db/migrate-add-recon.sql then bun run load-cases" });
  }
  const url = new URL(req.url);
  const source = url.searchParams.get("source");
  const tag = url.searchParams.get("tag");
  const imo = parseInt(url.searchParams.get("imo") ?? "", 10);

  const rows = await sql`
    SELECT id, title, summary, source, source_url, published_on, tags, imos,
           COALESCE(array_length(imos, 1), 0) AS vessel_count
    FROM known_cases
    WHERE TRUE
      ${source ? sql`AND source = ${source}` : sql``}
      ${tag ? sql`AND ${tag} = ANY(tags)` : sql``}
      ${Number.isFinite(imo) ? sql`AND ${imo}::bigint = ANY(imos)` : sql``}
    ORDER BY published_on DESC NULLS LAST, title
    LIMIT 500
  `;

  if (url.searchParams.get("format")?.toLowerCase() === "csv") {
    return csvResponse(rows as unknown as Array<Record<string, unknown>>,
      `cases-${new Date().toISOString().slice(0, 10)}.csv`,
      ["published_on", "source", "title", "vessel_count", "imos", "tags", "source_url", "summary"]);
  }
  return jsonResponse({ count: rows.length, results: rows });
}

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

// Ukrainian strikes on the oil facilities in oil_infra.
// Optional filters: ?infra_id=ryazan-refinery  ?since=2024-01-01  ?format=csv
async function handleInfraStrikes(req: Request): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const recon = await reconTables();
  if (!recon.strikes) {
    return jsonResponse({ count: 0, results: [], note: "infra_strikes table absent — run db/migrate-add-infra-strikes.sql then bun run load-infra-strikes" });
  }
  const url = new URL(req.url);
  const infraId = url.searchParams.get("infra_id");
  const since = url.searchParams.get("since");
  const sinceValid = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : null;
  const verifiedParam = url.searchParams.get("verified");
  const vf = verifiedParam === "true" ? true : verifiedParam === "false" ? false : null;

  const rows = await sql`
    SELECT id, infra_id, occurred_on, weapon, COALESCE(severity, 'unknown') AS severity, summary, source_urls, origin, verified
    FROM infra_strikes
    WHERE TRUE
      ${infraId ? sql`AND infra_id = ${infraId}` : sql``}
      ${sinceValid ? sql`AND occurred_on >= ${sinceValid}` : sql``}
      ${vf !== null ? sql`AND verified = ${vf}` : sql``}
    ORDER BY occurred_on DESC
    LIMIT 2000
  `;

  return maybeCsvOrJson(req, rows as unknown as Array<Record<string, unknown>>,
    `infra-strikes-${new Date().toISOString().slice(0, 10)}.csv`,
    ["occurred_on", "infra_id", "weapon", "summary", "source_urls", "origin", "verified"]);
}

// Aggregate strike impact on mapped refining capacity. Honest framing: this is
// the share of MAPPED refining capacity struck in a window, NOT % of Russian
// refining offline (struck ≠ fully offline).
async function handleStrikeImpact(): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const recon = await reconTables();
  if (!recon.infra || !recon.strikes) {
    return jsonResponse({ available: false, struck_7d: 0, struck_30d: 0, struck_90d: 0, strikes_7d: 0, strikes_30d: 0, strikes_90d: 0, capacity_struck_90d_mt_yr: 0, total_refining_capacity_mt_yr: 0 });
  }
  const rows = await sql`
    WITH refinery_total AS (
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
      (SELECT COUNT(DISTINCT infra_id) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 7) AS struck_7d,
      (SELECT COUNT(DISTINCT infra_id) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 30) AS struck_30d,
      (SELECT COUNT(DISTINCT infra_id) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 90) AS struck_90d,
      (SELECT COUNT(*) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 7) AS strikes_7d,
      (SELECT COUNT(*) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 30) AS strikes_30d,
      (SELECT COUNT(*) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 90) AS strikes_90d,
      (SELECT cap FROM cap90) AS capacity_struck_90d_mt_yr,
      (SELECT total FROM refinery_total) AS total_refining_capacity_mt_yr
  `;
  const r = rows[0] ?? {};
  const cap = Number(r.capacity_struck_90d_mt_yr ?? 0);
  const total = Number(r.total_refining_capacity_mt_yr ?? 0);
  // Latest external (cited) estimate of refining capacity offline — the headline
  // figure for the header tile. Graceful null when the table/data is absent.
  let latestOutage: Record<string, unknown> | null = null;
  if (recon.outage) {
    try {
      const o = await sql`
        SELECT as_of, offline_kbd, offline_pct, metric, source, source_url, note
        FROM refining_outage ORDER BY as_of DESC LIMIT 1
      `;
      latestOutage = o[0] ?? null;
    } catch { latestOutage = null; }
  }
  return jsonResponse({
    available: true,
    struck_7d: Number(r.struck_7d ?? 0),
    struck_30d: Number(r.struck_30d ?? 0),
    struck_90d: Number(r.struck_90d ?? 0),
    strikes_7d: Number(r.strikes_7d ?? 0),
    strikes_30d: Number(r.strikes_30d ?? 0),
    strikes_90d: Number(r.strikes_90d ?? 0),
    capacity_struck_90d_mt_yr: Math.round(cap * 10) / 10,
    total_refining_capacity_mt_yr: Math.round(total * 10) / 10,
    latest_outage: latestOutage,
  });
}

// Richer superset of /api/strike-impact for the Impact page (web/impact.html):
// the campaign's toll over time, sourced ONLY from infra_strikes ⋈ oil_infra.
// Honest framing throughout — capacity figures are NAMEPLATE exposure at struck
// facilities, not measured outage; no revenue is modelled (the CREA seed is
// illustrative). Graceful available:false when the recon tables are absent.
async function handleImpact(): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const recon = await reconTables();
  if (!recon.infra || !recon.strikes) {
    return jsonResponse({
      available: false,
      totals: {
        strikes_all: 0, strikes_30d: 0, strikes_90d: 0,
        struck_all: 0, struck_90d: 0,
        capacity_struck_90d_mt_yr: 0, total_refining_capacity_mt_yr: 0,
        pct_capacity_struck_90d: 0, corroborated: 0,
      },
      severity_totals: { minor: 0, moderate: 0, major: 0, unknown: 0 },
      major_facilities: 0,
      by_severity_monthly: [],
      outage_estimates: [],
      monthly: [], top_facilities: [], by_weapon: [], by_region: [],
    });
  }

  const totalsRows = await sql`
    WITH refinery_total AS (
      SELECT COALESCE(SUM(capacity_mt_yr), 0) AS total
      FROM oil_infra WHERE kind = 'refinery' AND capacity_mt_yr IS NOT NULL
    ),
    struck90 AS (
      SELECT DISTINCT infra_id FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 90
    ),
    cap90 AS (
      SELECT COALESCE(SUM(o.capacity_mt_yr), 0) AS cap
      FROM oil_infra o JOIN struck90 k ON o.id = k.infra_id
      WHERE o.kind = 'refinery' AND o.capacity_mt_yr IS NOT NULL
    )
    SELECT
      (SELECT COUNT(*) FROM infra_strikes) AS strikes_all,
      (SELECT COUNT(*) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 30) AS strikes_30d,
      (SELECT COUNT(*) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 90) AS strikes_90d,
      (SELECT COUNT(DISTINCT infra_id) FROM infra_strikes) AS struck_all,
      (SELECT COUNT(DISTINCT infra_id) FROM infra_strikes WHERE occurred_on >= CURRENT_DATE - 90) AS struck_90d,
      (SELECT cap FROM cap90) AS capacity_struck_90d_mt_yr,
      (SELECT total FROM refinery_total) AS total_refining_capacity_mt_yr,
      -- severity totals (impact-methodology revamp); null/absent severity → unknown
      (SELECT COUNT(*) FROM infra_strikes WHERE COALESCE(severity, 'unknown') = 'minor') AS sev_minor,
      (SELECT COUNT(*) FROM infra_strikes WHERE COALESCE(severity, 'unknown') = 'moderate') AS sev_moderate,
      (SELECT COUNT(*) FROM infra_strikes WHERE COALESCE(severity, 'unknown') = 'major') AS sev_major,
      (SELECT COUNT(*) FROM infra_strikes WHERE COALESCE(severity, 'unknown') = 'unknown') AS sev_unknown,
      (SELECT COUNT(DISTINCT infra_id) FROM infra_strikes WHERE COALESCE(severity, 'unknown') = 'major') AS major_facilities
  `;
  const t = totalsRows[0] ?? {};
  const cap90 = Number(t.capacity_struck_90d_mt_yr ?? 0);
  const totalCap = Number(t.total_refining_capacity_mt_yr ?? 0);
  const pct = totalCap > 0 ? Math.round((cap90 / totalCap) * 1000) / 10 : 0;

  const severity_totals = {
    minor: Number(t.sev_minor ?? 0),
    moderate: Number(t.sev_moderate ?? 0),
    major: Number(t.sev_major ?? 0),
    unknown: Number(t.sev_unknown ?? 0),
  };
  const major_facilities = Number(t.major_facilities ?? 0);

  const monthlyRows = await sql`
    SELECT to_char(occurred_on, 'YYYY-MM') AS month,
           COUNT(*) AS strikes,
           COUNT(DISTINCT infra_id) AS facilities
    FROM infra_strikes
    GROUP BY 1
    ORDER BY 1
  `;
  const monthly = fillMonthlySeries(
    (monthlyRows as unknown as Array<{ month: string; strikes: unknown; facilities: unknown }>).map((r) => ({
      month: r.month,
      strikes: Number(r.strikes ?? 0),
      facilities: Number(r.facilities ?? 0),
    })),
    "2022-01",
  );

  // strikes by severity per month (impact-methodology revamp). The DB only
  // emits months that had a strike; we gap-fill to a continuous 2022→now series
  // (mirroring fillMonthlySeries) so the chart has no holes. null/absent
  // severity counts toward "unknown".
  const sevRows = await sql`
    SELECT to_char(occurred_on, 'YYYY-MM') AS month,
           COALESCE(severity, 'unknown') AS severity,
           COUNT(*) AS strikes
    FROM infra_strikes
    GROUP BY 1, 2
  `;
  const sevByMonth = new Map<string, { minor: number; moderate: number; major: number; unknown: number }>();
  for (const r of sevRows as unknown as Array<{ month: string; severity: string; strikes: unknown }>) {
    const m = sevByMonth.get(r.month) ?? { minor: 0, moderate: 0, major: 0, unknown: 0 };
    const key = (["minor", "moderate", "major", "unknown"].includes(r.severity) ? r.severity : "unknown") as keyof typeof m;
    m[key] += Number(r.strikes ?? 0);
    sevByMonth.set(r.month, m);
  }
  // Reuse the canonical month sequence the gap-filler already produced.
  const by_severity_monthly = monthly.map((pt) => {
    const c = sevByMonth.get(pt.month) ?? { minor: 0, moderate: 0, major: 0, unknown: 0 };
    return { month: pt.month, minor: c.minor, moderate: c.moderate, major: c.major, unknown: c.unknown };
  });

  // External, source-cited offline estimates (others' numbers, not ours).
  // Graceful: [] when the table/flag is absent; try/catch around the SELECT.
  let outage_estimates: Array<Record<string, unknown>> = [];
  if (recon.outage) {
    try {
      const outRows = await sql`
        SELECT id, as_of, offline_kbd, offline_pct, metric, source, source_url, note
        FROM refining_outage
        ORDER BY as_of
      `;
      outage_estimates = (outRows as Array<Record<string, unknown>>).map((r) => ({
        id: r.id,
        as_of: r.as_of,
        offline_kbd: r.offline_kbd == null ? null : Number(r.offline_kbd),
        offline_pct: r.offline_pct == null ? null : Number(r.offline_pct),
        metric: r.metric,
        source: r.source,
        source_url: r.source_url,
        note: r.note,
      }));
    } catch {
      outage_estimates = [];
    }
  }

  const topRows = await sql`
    SELECT o.id, o.name, o.region, o.kind,
           COUNT(*) AS strikes,
           COUNT(*) FILTER (WHERE COALESCE(s.severity, 'unknown') = 'major') AS major_strikes,
           o.capacity_mt_yr,
           MAX(s.occurred_on) AS last_on
    FROM infra_strikes s
    JOIN oil_infra o ON o.id = s.infra_id
    GROUP BY o.id, o.name, o.region, o.kind, o.capacity_mt_yr
    ORDER BY strikes DESC, last_on DESC
    LIMIT 15
  `;
  const top_facilities = (topRows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id,
    name: r.name,
    region: r.region,
    kind: r.kind,
    strikes: Number(r.strikes ?? 0),
    major_strikes: Number(r.major_strikes ?? 0),
    capacity_mt_yr: r.capacity_mt_yr == null ? null : Number(r.capacity_mt_yr),
    last_on: r.last_on,
  }));

  const weaponRows = await sql`
    SELECT COALESCE(NULLIF(weapon, ''), 'unknown') AS weapon, COUNT(*) AS strikes
    FROM infra_strikes
    GROUP BY 1
    ORDER BY strikes DESC
  `;
  const by_weapon = (weaponRows as unknown as Array<{ weapon: string; strikes: unknown }>).map((r) => ({
    weapon: r.weapon,
    strikes: Number(r.strikes ?? 0),
  }));

  const regionRows = await sql`
    SELECT COALESCE(NULLIF(o.region, ''), '—') AS region, COUNT(*) AS strikes
    FROM infra_strikes s
    JOIN oil_infra o ON o.id = s.infra_id
    GROUP BY 1
    ORDER BY strikes DESC
    LIMIT 10
  `;
  const by_region = (regionRows as unknown as Array<{ region: string; strikes: unknown }>).map((r) => ({
    region: r.region,
    strikes: Number(r.strikes ?? 0),
  }));

  return jsonResponse({
    available: true,
    totals: {
      strikes_all: Number(t.strikes_all ?? 0),
      strikes_30d: Number(t.strikes_30d ?? 0),
      strikes_90d: Number(t.strikes_90d ?? 0),
      struck_all: Number(t.struck_all ?? 0),
      struck_90d: Number(t.struck_90d ?? 0),
      capacity_struck_90d_mt_yr: Math.round(cap90 * 10) / 10,
      total_refining_capacity_mt_yr: Math.round(totalCap * 10) / 10,
      pct_capacity_struck_90d: pct,
      corroborated: 0, // FIRMS join skipped for now — kept simple per spec
    },
    severity_totals,
    major_facilities,
    by_severity_monthly,
    outage_estimates,
    monthly,
    top_facilities,
    by_weapon,
    by_region,
  });
}

// One node in a supply chain — minimal infra detail for the panel chips.
interface ChainNode { id: string; kind: string; name: string; lat: number | null; lon: number | null; }
interface SupplyChain {
  pipeline: ChainNode | null;
  terminal: ChainNode | null;
  refineries: ChainNode[];
  depots: ChainNode[];
  commodity: string | null;
  source_urls: string[];
}

// Shared link-resolution for both /api/infra/:id/chain and the vessel-detail
// supply_chain block. Finds every curated link where `id` is the pipeline, the
// terminal, or one of the refineries, then resolves each referenced node's
// detail from oil_infra. Returns [] when the links table is absent or no link
// touches `id` (graceful — never throws on missing data).
async function resolveChainsFor(id: string): Promise<SupplyChain[]> {
  if (!sql) return [];
  const recon = await reconTables();
  if (!recon.links) return [];
  // depot_ids may be NULL (column added by migration, populated by a separate
  // research pass that may not have run yet) — COALESCE keeps it an empty array.
  const links = await sql`
    SELECT pipeline_id, terminal_id, refinery_ids,
           COALESCE(depot_ids, '{}'::text[]) AS depot_ids,
           commodity, source_urls
    FROM infra_links
    WHERE pipeline_id = ${id} OR terminal_id = ${id}
       OR ${id} = ANY(refinery_ids)
       OR ${id} = ANY(COALESCE(depot_ids, '{}'::text[]))
  ` as unknown as Array<{
    pipeline_id: string; terminal_id: string | null; refinery_ids: string[] | null;
    depot_ids: string[] | null;
    commodity: string | null; source_urls: string[] | null;
  }>;
  if (links.length === 0) return [];

  // Resolve every referenced node in one round-trip.
  const ids = new Set<string>();
  for (const l of links) {
    ids.add(l.pipeline_id);
    if (l.terminal_id) ids.add(l.terminal_id);
    for (const rid of l.refinery_ids ?? []) ids.add(rid);
    for (const did of l.depot_ids ?? []) ids.add(did);
  }
  const nodeRows = recon.infra
    ? await sql`SELECT id, kind, name, lat, lon FROM oil_infra WHERE id = ANY(${[...ids]}::text[])` as unknown as ChainNode[]
    : [];
  const byId = new Map<string, ChainNode>(nodeRows.map((n) => [n.id, n]));

  return links.map((l) => ({
    pipeline: byId.get(l.pipeline_id) ?? null,
    terminal: l.terminal_id ? byId.get(l.terminal_id) ?? null : null,
    refineries: (l.refinery_ids ?? []).map((rid) => byId.get(rid)).filter((n): n is ChainNode => !!n),
    depots: (l.depot_ids ?? []).map((did) => byId.get(did)).filter((n): n is ChainNode => !!n),
    commodity: l.commodity,
    source_urls: l.source_urls ?? [],
  }));
}

// Supply chain for any infra node (terminal / pipeline / refinery), bidirectional.
async function handleInfraChain(id: string): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const recon = await reconTables();
  if (!recon.links) {
    return jsonResponse({ available: false, chains: [], note: "infra_links table absent — run db/migrate-add-infra-links.sql then bun run load-infra-links" });
  }
  const chains = await resolveChainsFor(id);
  return jsonResponse({ available: true, chains });
}

interface TerminalTanker {
  imo: string | null;
  mmsi: string;
  name: string | null;
  sanctioned: boolean;
  dest_raw: string | null;
  last_ts: string | null;
}

// Live tankers routed to a terminal — closes the chain to the sea. Looks up the
// terminal's LOCODE (oil_infra.raw->>'locode'), then finds tankers whose latest
// AIS position carries a destination decoding to that port code. Only meaningful
// for terminals; anything else (or a terminal with no locode) returns an empty
// list. Graceful empty when the vessels/positions/oil_infra tables are absent.
async function handleInfraTankers(id: string): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });
  const recon = await reconTables();
  if (!recon.infra) return jsonResponse({ available: true, tankers: [] });

  const termRows = await sql`
    SELECT raw->>'locode' AS locode
    FROM oil_infra WHERE id = ${id} AND kind = 'terminal'
  ` as unknown as Array<{ locode: string | null }>;
  const term = termRows[0];
  const locode = term?.locode ? String(term.locode).trim().toUpperCase() : "";
  if (!term || !locode) return jsonResponse({ available: true, tankers: [] });

  // Latest position per tanker (recent), with raw destination + sanctioned flag.
  // We over-fetch on a cheap prefix match (destination starts with the 2-letter
  // country part of the locode) then confirm in JS with the same parseDestination
  // the rest of the app uses, so multi-shape AIS strings ("RUPRI>EGSUZ") decode
  // identically. LIMIT keeps the candidate set bounded before the JS filter.
  let rows: Array<{ imo: string | null; mmsi: string; name: string | null; destination: string | null; sanctioned: boolean; ts: string | null }>;
  try {
    rows = await sql`
      WITH latest_positions AS (
        SELECT DISTINCT ON (mmsi) mmsi, ts
        FROM positions
        WHERE ts > NOW() - INTERVAL '48 hours'
        ORDER BY mmsi, ts DESC
      )
      SELECT
        v.imo::text  AS imo,
        v.mmsi::text AS mmsi,
        v.name,
        v.destination,
        lp.ts,
        EXISTS(SELECT 1 FROM sanctioned_vessels s WHERE s.imo = v.imo) AS sanctioned
      FROM vessels v
      JOIN latest_positions lp ON v.mmsi = lp.mmsi
      WHERE v.ship_type BETWEEN 80 AND 89
        AND v.destination IS NOT NULL
        AND UPPER(v.destination) LIKE ${locode.slice(0, 2) + "%"}
      ORDER BY lp.ts DESC
      LIMIT 500
    ` as unknown as typeof rows;
  } catch {
    return jsonResponse({ available: true, tankers: [] });
  }

  const matched: TerminalTanker[] = [];
  for (const r of rows) {
    const d = parseDestination(r.destination);
    const code = d.port?.code ?? d.destination?.code ?? null;
    if (code !== locode) continue;
    matched.push({
      imo: r.imo,
      mmsi: r.mmsi,
      name: r.name,
      sanctioned: !!r.sanctioned,
      dest_raw: r.destination,
      last_ts: r.ts,
    });
    if (matched.length >= 20) break;
  }

  return jsonResponse({ available: true, locode, tankers: matched });
}

async function handleFires(): Promise<Response> {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return jsonResponse({ available: false, points: [], facilities: {}, note: "FIRMS_MAP_KEY not set" });
  const all = await fetchFirmsPoints(key);
  let facilities: Record<string, unknown> = {};
  let nearPoints: FirePoint[] = [];
  if (sql) {
    const recon = await reconTables();
    if (recon.infra) {
      const fac = await sql`SELECT id, lat, lon FROM oil_infra WHERE lat IS NOT NULL` as unknown as FacilityPoint[];
      facilities = matchFiresToFacilities(all, fac, 3);
      // Map layer shows only anomalies inside infrastructure zones (≤5 km),
      // not the global agricultural/flare firehose.
      nearPoints = filterNearFacilities(all, fac, 5);
    }
  }
  const burning = Object.values(facilities).filter((a) => (a as { active: boolean }).active).length;
  return jsonResponse({ available: true, count: nearPoints.length, scanned: all.length, burning, points: nearPoints, facilities });
}

async function handleDigest(): Promise<Response> {
  if (!sql) return jsonResponse({ error: "no_db" }, { status: 500 });

  // Top high-risk vessels currently visible (last 24h)
  const visibleRes = await fetch(`http://localhost:${process.env.PORT ?? "3000"}/api/sanctioned-active`);
  const visibleData = await visibleRes.json() as { vessels: Array<Record<string, unknown>> };

  const topRisk = visibleData.vessels.slice(0, 10);
  const russiaLinkedVisible = visibleData.vessels.filter((v) => v.russia_ukraine_linked);

  // First-seen-today vessels
  const newToday = await sql`
    SELECT v.mmsi::text as mmsi, v.imo::text as imo, v.name, v.ship_type, v.first_seen
    FROM vessels v
    WHERE v.first_seen > CURRENT_DATE
    ORDER BY v.first_seen DESC
    LIMIT 50
  `;

  // Recent darkness in suspect zones — find vessels whose last position was inside a zone but no update in >1h
  const stalish = await sql`
    WITH latest AS (
      SELECT DISTINCT ON (mmsi) mmsi, lat, lon, ts
      FROM positions
      WHERE ts > NOW() - INTERVAL '24 hours'
      ORDER BY mmsi, ts DESC
    )
    SELECT v.mmsi::text as mmsi, v.imo::text as imo, v.name, l.lat, l.lon, l.ts
    FROM vessels v
    JOIN latest l ON v.mmsi = l.mmsi
    JOIN sanctioned_vessels s ON v.imo = s.imo
    WHERE v.ship_type BETWEEN 80 AND 89
      AND l.ts < NOW() - INTERVAL '1 hour'
    ORDER BY l.ts DESC
    LIMIT 30
  `;
  const inZoneStale = stalish
    .map((r) => ({ ...r, zone: findZone(r.lat as number, r.lon as number) }))
    .filter((r) => r.zone !== null)
    .slice(0, 15);

  return jsonResponse({
    generated_at: new Date().toISOString(),
    top_risk: topRisk,
    russia_linked_visible: { count: russiaLinkedVisible.length, sample: russiaLinkedVisible.slice(0, 5) },
    new_today: { count: newToday.length, sample: newToday.slice(0, 10) },
    dark_in_zones: { count: inZoneStale.length, sample: inZoneStale },
  });
}

async function serveStatic(pathname: string): Promise<Response> {
  const path = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(join(WEB_DIR, path));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file);
}

const server = Bun.serve({
  port: parseInt(process.env.PORT ?? "3000", 10),
  idleTimeout: 30, // GDELT fetch may take several seconds on cold cache

  async fetch(req) {
    const url = new URL(req.url);
    try {
      // Hot GET endpoints — 20 s in-memory cache
      if (url.pathname === "/api/sanctioned-active") return await withCache(req, 20_000, () => handleSanctionedActive(req));
      if (url.pathname === "/api/tankers-active")    return await withCache(req, 20_000, () => handleTankersActive());
      if (url.pathname === "/api/stats")             return await withCache(req, 30_000, () => handleStats());
      if (url.pathname === "/api/zones")             return await withCache(req, 600_000, () => handleZones());
      if (url.pathname === "/api/infra")             return await withCache(req, 600_000, () => handleInfra(req));
      if (url.pathname === "/api/attacks")           return await withCache(req, 300_000, () => handleAttacks(req));
      if (url.pathname === "/api/infra-strikes")     return await withCache(req, 300_000, () => handleInfraStrikes(req));
      if (url.pathname === "/api/strike-impact")     return await withCache(req, 300_000, () => handleStrikeImpact());
      if (url.pathname === "/api/impact")            return await withCache(req, 300_000, () => handleImpact());
      if (url.pathname === "/api/fires")             return await withCache(req, 3_600_000, () => handleFires());
      if (url.pathname === "/api/cases")             return await withCache(req, 300_000, () => handleCases(req));
      if (url.pathname === "/api/digest")            return await withCache(req, 60_000, () => handleDigest());
      if (url.pathname === "/api/timeline")          return await withCache(req, 30_000, () => handleTimeline(req));
      if (url.pathname === "/api/sts-candidates")    return await withCache(req, 30_000, () => handleStsCandidates(req));
      if (url.pathname === "/api/sts-events")        return await withCache(req, 30_000, () => handleStsEvents(req));
      if (url.pathname === "/api/fleet-stats")       return await withCache(req, 60_000, () => handleFleetStats(req));
      if (url.pathname === "/api/newly-active")      return await withCache(req, 60_000, () => handleNewlyActive(req));
      if (url.pathname === "/api/newly-listed")      return await withCache(req, 300_000, () => handleNewlyListed(req));
      if (url.pathname === "/api/batch-screen")      return await handleBatchScreen(req);
      if (url.pathname === "/api/advanced-filter")   return await withCache(req, 30_000, () => handleAdvancedFilter(req));
      const wikiMatch = url.pathname.match(/^\/api\/vessel\/(\d+)\/wiki$/);
      if (wikiMatch) return await handleVesselWiki(wikiMatch[1]!);
      const ownerActivityMatch = url.pathname.match(/^\/api\/owner-fleet-activity\/([A-Za-z0-9._:\-]+)$/);
      if (ownerActivityMatch) return await handleOwnerFleetActivity(ownerActivityMatch[1]!, req);
      const newsMatch = url.pathname.match(/^\/api\/vessel\/(\d+)\/news$/);
      if (newsMatch) return await handleVesselNews(newsMatch[1]!);
      const pcMatch = url.pathname.match(/^\/api\/vessel\/(\d+)\/portcalls$/);
      if (pcMatch) return await handleVesselPortCalls(pcMatch[1]!);
      if (url.pathname === "/api/entity-search")     return await handleEntitySearch(req);
      const entityMatch = url.pathname.match(/^\/api\/entity\/([A-Za-z0-9._:\-]+)$/);
      if (entityMatch) return await handleEntityDetail(entityMatch[1]!);
      const ownershipMatch = url.pathname.match(/^\/api\/vessel\/(\d+)\/ownership$/);
      if (ownershipMatch) return await withCache(req, 300_000, () => handleVesselOwnership(ownershipMatch[1]!));
      const chainMatch = url.pathname.match(/^\/api\/infra\/([A-Za-z0-9_-]+)\/chain$/);
      if (chainMatch) return await withCache(req, 600_000, () => handleInfraChain(chainMatch[1]!));
      const tankersMatch = url.pathname.match(/^\/api\/infra\/([A-Za-z0-9_-]+)\/tankers$/);
      if (tankersMatch) return await withCache(req, 30_000, () => handleInfraTankers(tankersMatch[1]!));
      const vesselMatch = url.pathname.match(/^\/api\/vessel\/(\d+)$/);
      if (vesselMatch) return await withCache(req, 30_000, () => handleVesselDetail(vesselMatch[1]!, req));
      return await serveStatic(url.pathname);
    } catch (err) {
      logger.error({ event: "request_error", path: url.pathname, err: String(err) }, "request failed");
      return jsonResponse({ error: "internal" }, { status: 500 });
    }
  },
});

logger.info({ event: "server_start", port: server.port, webDir: WEB_DIR }, "oilfront server up");
