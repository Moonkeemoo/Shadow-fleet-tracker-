// Pure clustering: collapse the same real-world strike — reported by multiple
// feeds (RSS, GDELT, curated, manual) on slightly different dates — into ONE
// event so the confidence engine scores the event, not each duplicate row.
// No network, no clock; dates are plain "YYYY-MM-DD" parsed via Date.UTC.

export interface StrikeInput {
  id: string;
  infra_id: string;
  occurred_on: string;
  weapon: string;
  severity: string;
  summary: string;
  source_urls: string[];
  origin: string;
}

export interface StrikeCluster {
  infra_id: string;
  // Canonical date for the cluster = the EARLIEST member date. Chosen because the
  // first report of a strike is the strike's actual day; later same-event rows are
  // republications/satellite confirmations that drift forward by a day or two.
  occurred_on: string;
  member_ids: string[];
  origins: string[];
  source_urls: string[];
  summaries: string[];
}

// Absolute day difference between two "YYYY-MM-DD" strings using UTC math
// (mirrors fires-match.ts's utcDaysBetween — kept local so this module is
// self-contained and importable without pulling in the FIRMS matcher).
function utcDaysBetween(a: string, b: string): number {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.abs((da - db) / 86_400_000);
}

// Push x onto arr only if not already present (exact-match dedup).
function pushUnique(arr: string[], x: string): void {
  if (!arr.includes(x)) arr.push(x);
}

/**
 * Group rows by infra_id where occurred_on values are within ±1 calendar day
 * (UTC) of each other, into single events.
 *
 * Deterministic algorithm: sort by (infra_id, occurred_on, id), then greedily
 * merge consecutive same-facility rows whose dates are ≤1 day apart into one
 * cluster. Merging is transitive within a chain — a run of rows each ≤1 day from
 * the previous (e.g. Jun 8 / Jun 9 / Jun 10) all collapse into one cluster, even
 * though the endpoints are 2 days apart. This is intentional and documented: a
 * multi-day report run about the same facility is almost always one event.
 */
export function clusterStrikes(rows: StrikeInput[]): StrikeCluster[] {
  if (rows.length === 0) return [];

  const sorted = [...rows].sort((a, b) => {
    if (a.infra_id !== b.infra_id) return a.infra_id < b.infra_id ? -1 : 1;
    if (a.occurred_on !== b.occurred_on) return a.occurred_on < b.occurred_on ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const clusters: StrikeCluster[] = [];
  let cur: StrikeCluster | null = null;
  let prevDate = "";

  for (const r of sorted) {
    const sameFacility = cur !== null && cur.infra_id === r.infra_id;
    const withinWindow = sameFacility && utcDaysBetween(prevDate, r.occurred_on) <= 1;

    if (cur === null || !sameFacility || !withinWindow) {
      // occurred_on starts as this row's date — and since rows are sorted
      // ascending by date, the first row of a cluster carries the EARLIEST date.
      cur = {
        infra_id: r.infra_id,
        occurred_on: r.occurred_on,
        member_ids: [],
        origins: [],
        source_urls: [],
        summaries: [],
      };
      clusters.push(cur);
    }

    pushUnique(cur.member_ids, r.id);
    pushUnique(cur.origins, r.origin);
    for (const u of r.source_urls) pushUnique(cur.source_urls, u);
    if (r.summary) cur.summaries.push(r.summary);

    // Advance the chain anchor to the latest seen date so the next row is
    // compared against the most recent member (enables transitive merging).
    prevDate = r.occurred_on;
  }

  return clusters;
}
