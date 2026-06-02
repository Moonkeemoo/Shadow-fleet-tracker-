// Composite risk scoring for vessels.
// Pure function. Inputs are observed facts; output is 0-100 score with explainable factors.
//
// Methodology (transparent — every score breaks down into named factors):
//   +5 per sanction list (cap at 30)
//   +20 if Russia/Ukraine sanctions linked
//   +10 flag of convenience (curated FoC ISO list)
//   +10 currently AIS-dark (>60 min since last broadcast)
//   +15 AIS gap (>30 min) within last 24h overlapping a known suspect zone
//   +5  longest 24h gap >2h
//   +10 ownership chain touches a sanctioned-state entity
//   --- vessel-profile + behaviour signals (recon data sources, 2026-06) ---
//   +5/+15 flag-hopping (≥2 prior flags on FtM record; scales to cap)
//   +5/+10 ageing hull (≥15y / ≥20y)
//   +10 Port State Control detention in last 24 months (Paris/Tokyo MoU)
//   +15 suspected AIS position spoofing (implausible position jump in track)
//   +10 loitering near-stationary inside an STS / sanctioned zone
//   +10 named in a documented investigation (KSE / CREA / UANI / OCCRP seed)
// Capped at 100. Buckets: 0-29 low, 30-59 elevated, 60-79 high, 80+ critical.

export interface RiskInputs {
  sanction_count: number;             // distinct source-list count
  russia_ukraine_linked: boolean;
  flag_of_convenience: boolean;
  ais_dark_minutes: number;           // since last position; 0 if currently broadcasting
  longest_gap_min_24h: number;
  gap_in_suspect_zone_24h: boolean;
  chain_has_sanctioned_country: boolean; // ownership chain touches a sanctioned-state owner (ru/ir/kp/by/sy/ve)
  // --- recon additions (optional; default to no-op when absent) ---
  flag_changes_count?: number;        // distinct prior flags on FtM record (flag-hopping)
  vessel_age_years?: number | null;   // hull age derived from build year
  psc_detained_recently?: boolean;    // Port State Control detention within 24 months
  ais_spoofing_suspected?: boolean;   // implausible position jump observed in track
  loitering_in_zone?: boolean;        // prolonged near-stationary dwell inside a suspect zone
  in_known_case?: boolean;            // appears in a curated investigative case dataset
}

export interface RiskFactor {
  name: string;
  contribution: number;
}

export interface RiskResult {
  score: number;            // 0-100
  bucket: "low" | "elevated" | "high" | "critical";
  factors: RiskFactor[];
}

export function computeRisk(inp: RiskInputs): RiskResult {
  const factors: RiskFactor[] = [];
  let score = 0;

  if (inp.sanction_count > 0) {
    const c = Math.min(30, inp.sanction_count * 5);
    factors.push({ name: `${inp.sanction_count} sanction list${inp.sanction_count > 1 ? "s" : ""}`, contribution: c });
    score += c;
  }
  if (inp.russia_ukraine_linked) {
    factors.push({ name: "Russia/Ukraine sanctions linked", contribution: 20 });
    score += 20;
  }
  if (inp.flag_of_convenience) {
    factors.push({ name: "Flag of convenience", contribution: 10 });
    score += 10;
  }
  if (inp.ais_dark_minutes >= 60) {
    factors.push({ name: `Currently AIS-dark ${Math.round(inp.ais_dark_minutes / 60)}h`, contribution: 10 });
    score += 10;
  }
  if (inp.gap_in_suspect_zone_24h) {
    factors.push({ name: "AIS gap inside STS / sanctioned zone (24h)", contribution: 15 });
    score += 15;
  }
  if (inp.longest_gap_min_24h >= 120) {
    factors.push({ name: `24h longest gap ${Math.round(inp.longest_gap_min_24h / 60)}h`, contribution: 5 });
    score += 5;
  }
  if (inp.chain_has_sanctioned_country) {
    factors.push({ name: "Ownership chain touches sanctioned-state entity", contribution: 10 });
    score += 10;
  }

  // --- recon signals ---
  // Flag-hopping: repeated re-flagging is a textbook shadow-fleet evasion pattern.
  const flagChanges = inp.flag_changes_count ?? 0;
  if (flagChanges >= 2) {
    const c = Math.min(15, flagChanges * 5);
    factors.push({ name: `${flagChanges} prior flags (flag-hopping)`, contribution: c });
    score += c;
  }
  // Ageing tonnage: shadow fleet concentrates in old hulls near end of economic life.
  const age = inp.vessel_age_years ?? null;
  if (age !== null && age >= 20) {
    factors.push({ name: `Ageing hull (${age}y, ≥20y)`, contribution: 10 });
    score += 10;
  } else if (age !== null && age >= 15) {
    factors.push({ name: `Ageing hull (${age}y, ≥15y)`, contribution: 5 });
    score += 5;
  }
  if (inp.psc_detained_recently) {
    factors.push({ name: "Port State Control detention (24mo)", contribution: 10 });
    score += 10;
  }
  if (inp.ais_spoofing_suspected) {
    factors.push({ name: "Suspected AIS position spoofing", contribution: 15 });
    score += 15;
  }
  if (inp.loitering_in_zone) {
    factors.push({ name: "Loitering inside STS / sanctioned zone", contribution: 10 });
    score += 10;
  }
  if (inp.in_known_case) {
    factors.push({ name: "Named in documented investigation", contribution: 10 });
    score += 10;
  }

  const capped = Math.min(100, score);
  const bucket: RiskResult["bucket"] =
    capped >= 80 ? "critical" : capped >= 60 ? "high" : capped >= 30 ? "elevated" : "low";
  return { score: capped, bucket, factors };
}

// Curated flag-of-convenience ISO 3166-1 alpha-2 codes per ITF + KSE shadow-fleet research.
// Lower-cased for OpenSanctions normalization.
const FOC_ISO2: ReadonlySet<string> = new Set([
  "pa", // Panama
  "lr", // Liberia
  "mh", // Marshall Islands
  "cy", // Cyprus
  "mt", // Malta
  "an", // Antigua & Barbuda (some)
  "bs", // Bahamas
  "bz", // Belize
  "bm", // Bermuda
  "kh", // Cambodia
  "km", // Comoros
  "ck", // Cook Islands
  "dj", // Djibouti
  "ga", // Gabon
  "gn", // Guinea
  "hn", // Honduras
  "jm", // Jamaica
  "ki", // Kiribati
  "lb", // Lebanon
  "lk", // Sri Lanka
  "mn", // Mongolia
  "mu", // Mauritius
  "nu", // Niue
  "pw", // Palau
  "st", // São Tomé and Príncipe
  "tg", // Togo
  "to", // Tonga
  "vu", // Vanuatu
  "su", // ex-Soviet
]);

export function isFlagOfConvenience(flag: string | null | undefined): boolean {
  if (!flag) return false;
  return FOC_ISO2.has(flag.toLowerCase());
}

// ---------------------------------------------------------------------------
// Recon signal derivation — pure helpers shared by the API endpoints.
// Kept here (alongside computeRisk) so the scoring logic and the feature
// extraction that feeds it live together and are unit-tested as one unit.
// ---------------------------------------------------------------------------

// Count of distinct prior flags recorded on an FtM `pastFlags` array.
// Accepts the raw JSONB value (array | null | anything) and is defensive.
export function flagHopCount(pastFlags: unknown): number {
  if (!Array.isArray(pastFlags)) return 0;
  const distinct = new Set(
    pastFlags.map((f) => String(f).trim().toLowerCase()).filter((s) => s.length > 0),
  );
  return distinct.size;
}

// Hull age in years from an FtM `buildDate` ("YYYY" or "YYYY-MM-DD…").
// Returns null when unparseable or implausible.
export function vesselAgeYears(buildDate: string | null | undefined, nowYear: number): number | null {
  if (!buildDate) return null;
  const m = String(buildDate).match(/^(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1]!, 10);
  if (!Number.isFinite(y) || y < 1900 || y > nowYear) return null;
  return nowYear - y;
}

export interface TrackPoint {
  lat: number;
  lon: number;
  ts: string;
  sog?: number | null;
}

export interface SpoofJump {
  from_ts: string;
  to_ts: string;
  distance_nm: number;
  implied_kn: number;
}

// Great-circle distance in nautical miles.
export function nmBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 3440.065; // Earth radius in nm
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Detect implausible position jumps in a chronological track.
// A jump where the implied speed between consecutive fixes exceeds a physical
// ceiling (default 40 kn — no laden tanker sustains that) is a strong indicator
// of AIS position spoofing or MMSI/identity manipulation. A minimum distance
// gate (>5 nm) suppresses dockside GPS jitter.
export function detectSpoofJumps(track: TrackPoint[], maxKn = 40, minNm = 5): SpoofJump[] {
  const jumps: SpoofJump[] = [];
  for (let i = 1; i < track.length; i++) {
    const p = track[i - 1]!;
    const c = track[i]!;
    const dtH = (new Date(c.ts).getTime() - new Date(p.ts).getTime()) / 3_600_000;
    if (dtH <= 0) continue;
    const dist = nmBetween(p.lat, p.lon, c.lat, c.lon);
    const kn = dist / dtH;
    if (kn > maxKn && dist > minNm) {
      jumps.push({
        from_ts: p.ts,
        to_ts: c.ts,
        distance_nm: Math.round(dist),
        implied_kn: Math.round(kn),
      });
    }
  }
  return jumps;
}
