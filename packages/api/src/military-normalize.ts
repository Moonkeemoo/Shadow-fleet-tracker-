// Pure normalization for the military-industrial sites dataset
// (data/military-sites.json). Every site must carry at least one http(s)
// source URL and valid coordinates — uncited / unlocatable records are dropped.
// Strikes are embedded per site; invalid strikes are silently dropped.
// No Bun/Postgres deps — unit-testable with node --test.

import { toStr, toCoord, toIsoDate, toUrls } from "./infra-normalize.ts";

export interface MilitaryStrike {
  occurred_on: string;
  weapon: "uav" | "missile" | "sabotage" | "unknown";
  severity: "major" | "moderate" | "minor" | "unknown";
  summary: string | null;
  source_urls: string[];
}

export interface MilitarySite {
  id: string;
  name: string;
  name_local: string | null;
  lat: number;
  lon: number;
  category: "drone" | "missile" | "ammunition" | "explosives" | "armor" | "aviation" | "electronics" | "shipyard" | "other";
  produces: string | null;
  operator: string | null;
  region: string | null;
  status: "operational" | "damaged" | "destroyed" | "unknown";
  strikes: MilitaryStrike[];
  notes: string | null;
  source_urls: string[];
  raw: Record<string, unknown>;
}

const CATEGORIES = new Set([
  "drone", "missile", "ammunition", "explosives", "armor",
  "aviation", "electronics", "shipyard", "other",
]);
const STATUSES = new Set(["operational", "damaged", "destroyed", "unknown"]);
// Includes "sabotage" — unlike infra's weapon enum which only has uav/missile/unknown.
const STRIKE_WEAPONS = new Set(["uav", "missile", "sabotage", "unknown"]);
const STRIKE_SEVERITIES = new Set(["major", "moderate", "minor", "unknown"]);

function normalizeMilitaryStrike(raw: unknown): MilitaryStrike | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const occurred_on = toIsoDate(r.occurred_on);
  if (!occurred_on) return null;

  const source_urls = toUrls(r.source_urls);
  if (source_urls.length === 0) return null;

  const weaponRaw = toStr(r.weapon);
  const weapon = weaponRaw && STRIKE_WEAPONS.has(weaponRaw) ? weaponRaw : "unknown";

  const severityRaw = toStr(r.severity);
  const severity = severityRaw && STRIKE_SEVERITIES.has(severityRaw) ? severityRaw : "unknown";

  return {
    occurred_on,
    weapon: weapon as MilitaryStrike["weapon"],
    severity: severity as MilitaryStrike["severity"],
    summary: toStr(r.summary),
    source_urls,
  };
}

export function normalizeMilitarySite(raw: Record<string, unknown>): MilitarySite | null {
  const id = toStr(raw.id);
  const name = toStr(raw.name);
  if (!id || !name) return null;

  const lat = toCoord(raw.lat, -90, 90);
  const lon = toCoord(raw.lon, -180, 180);
  if (lat === null || lon === null) return null;

  const source_urls = toUrls(raw.source_urls);
  if (source_urls.length === 0) return null;

  const categoryRaw = toStr(raw.category);
  const category = categoryRaw && CATEGORIES.has(categoryRaw) ? categoryRaw : "other";

  const statusRaw = toStr(raw.status);
  const status = statusRaw && STATUSES.has(statusRaw) ? statusRaw : "unknown";

  const rawStrikes = Array.isArray(raw.strikes) ? raw.strikes : [];
  const strikes = rawStrikes.map(normalizeMilitaryStrike).filter((s): s is MilitaryStrike => s !== null);

  return {
    id,
    name,
    name_local: toStr(raw.name_local),
    lat,
    lon,
    category: category as MilitarySite["category"],
    produces: toStr(raw.produces),
    operator: toStr(raw.operator),
    region: toStr(raw.region),
    status: status as MilitarySite["status"],
    strikes,
    notes: toStr(raw.notes),
    source_urls,
    raw,
  };
}

/** Derived — true when the site has at least one recorded (and valid) strike. */
export function isStruck(site: MilitarySite): boolean {
  return site.strikes.length > 0;
}
