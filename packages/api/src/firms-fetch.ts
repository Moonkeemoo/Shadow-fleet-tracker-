// Shared NASA FIRMS area-CSV fetch + parse, used by both the live /api/fires
// endpoint (server.ts) and the FIRMS-triggered strike loader
// (cli/load-firms-triggered.ts). One regional-bbox × source loop, the same
// graceful per-call guards (non-200, non-CSV bodies are warned and skipped so
// one bad sub-request never aborts the whole fetch). Parsing is pure.
import { logger } from "./log.ts";
import type { FirePoint } from "./fires-match.ts";

// FIRMS area CSV: dayRange max 5; VIIRS 375m. Regional bboxes "W,S,E,N".
export const FIRMS_BBOXES = ["19,44,65,70", "36,50,62,58", "60,52,92,62", "125,42,145,55", "36,41,55,48"];
export const FIRMS_SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_SNPP_NRT"];

export function parseFirmsCsv(text: string): FirePoint[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0]!.split(",");
  const ix = (n: string) => header.indexOf(n);
  const iLat = ix("latitude"), iLon = ix("longitude"), iConf = ix("confidence"), iFrp = ix("frp"), iDate = ix("acq_date"), iDn = ix("daynight");
  const out: FirePoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i]!.split(",");
    const lat = Number(c[iLat]); const lon = Number(c[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({ lat, lon, confidence: String(c[iConf] ?? "").trim(), frp: Number(c[iFrp]) || 0, acq_date: String(c[iDate] ?? "").trim(), daynight: String(c[iDn] ?? "").trim() });
  }
  return out;
}

// Fetches every regional bbox × VIIRS source and concatenates the parsed
// points. Guards mirror the original handleFires loop: a failed fetch / non-CSV
// body / thrown error is warned and skipped, never thrown — the caller always
// gets whatever points succeeded.
export async function fetchFirmsPoints(key: string): Promise<FirePoint[]> {
  const all: FirePoint[] = [];
  for (const src of FIRMS_SOURCES) {
    for (const bbox of FIRMS_BBOXES) {
      try {
        const res = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${src}/${bbox}/3`, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) { logger.warn({ event: "firms_error", status: res.status, src, bbox }, "FIRMS fetch failed"); continue; }
        const text = await res.text();
        if (text.startsWith("Invalid") || text.includes("<html")) { logger.warn({ event: "firms_bad_body", src, bbox, sample: text.slice(0, 60) }, "FIRMS non-CSV"); continue; }
        all.push(...parseFirmsCsv(text));
      } catch (err) { logger.warn({ event: "firms_exception", err: String(err), src, bbox }, "FIRMS threw"); }
    }
  }
  return all;
}
