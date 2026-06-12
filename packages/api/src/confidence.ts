// Pure confidence engine: turns a clustered strike + its satellite aggregate into
// a deterministic, fully explainable tier. No network, no clock — `asOfDate` is
// passed in (mirrors fires-match.ts). This is the heart of the project's tagline:
// "reproducible methodology, all factors explainable". Phase 1 = keyword
// heuristics for attribution/contradiction; Phase 2 swaps those for an LLM signal
// feeding the SAME deterministic scorer.

import type { FireAggregate } from "./fires-match.ts";
import type { StrikeCluster } from "./strike-cluster.ts";

// --- Source reputation -------------------------------------------------------

// T1: high-trust outlets whose single report meaningfully corroborates (weight 2).
const T1_DOMAINS: ReadonlySet<string> = new Set([
  "reuters.com",
  "bbc.com",
  "bbc.co.uk",
  "kyivindependent.com",
  "militarnyi.com",
  "defense-ua.com",
  "en.defence-ua.com",
  "understandingwar.org", // ISW
  "rferl.org",
  "pravda.com.ua",
  "euromaidanpress.com",
  "themoscowtimes.com",
  "kyivpost.com",
  "united24media.com",
  "ukrinform.net",
]);

// T0: raw social / opaque redirects — ignored as independent corroboration
// (weight 0). Kept deliberately small; everything not T0 and not T1 = T2.
const T0_DOMAINS: ReadonlySet<string> = new Set([
  "t.me",
  "telegram.me",
  "telegram.org",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "facebook.com",
  "vk.com",
  // Google-News redirect: not the real outlet, so it must not inflate counts.
  "news.google.com",
]);

/** Extract a bare lowercase domain from a URL string (strip protocol, www., path). */
export function domainOf(url: string): string {
  let s = url.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme://
  s = s.replace(/^www\./, "");
  s = s.split("/")[0] ?? s; // drop path
  s = s.split("?")[0] ?? s; // drop query if no path slash
  s = s.split("#")[0] ?? s; // drop fragment
  s = s.split(":")[0] ?? s; // drop port
  return s;
}

/** Source reputation weight for a domain or URL: 2 (T1), 1 (T2), 0 (T0). */
export function reputationOf(domain: string): 0 | 1 | 2 {
  const d = domainOf(domain);
  if (T0_DOMAINS.has(d)) return 0;
  if (T1_DOMAINS.has(d)) return 2;
  return 1;
}

// --- Evidence assembly -------------------------------------------------------

export interface StrikeEvidence {
  infra_id: string;
  occurred_on: string;
  sources: { url: string; domain: string; weight: 0 | 1 | 2 }[];
  reputable_count: number;
  satellite: { hit: boolean; last_date: string | null };
  attribution: { official: boolean; who: string | null };
  contradiction: { found: boolean; kind: string | null };
  trusted_manual: boolean;
  origins: string[];
  member_ids: string[];
}

// Official UA-agency attribution keywords. First match (case-insensitive) wins as `who`.
const ATTRIBUTION_TOKENS: readonly string[] = [
  "SBU",
  "GUR",
  "HUR",
  "General Staff",
  "Special Operations Forces",
  "SOF",
  "Defense Intelligence",
  "DIU",
  "СБУ",
  "ГУР",
  "Генштаб",
  "ССО",
];

// Contradiction / denial keywords. First match caps the tier → 'retracted'.
const CONTRADICTION_TOKENS: readonly string[] = [
  "intercepted",
  "shot down",
  "no damage",
  "denied",
  "debris fell",
  "fell near",
  "спростовано",
  "перехоплено",
  "збили",
  "без шкоди",
  "уламки",
];

const TRUSTED_ORIGINS: ReadonlySet<string> = new Set(["manual", "curated"]);

/** First token from `tokens` that occurs in `haystack` (case-insensitive), else null. */
function firstMatch(haystack: string, tokens: readonly string[]): string | null {
  const hay = haystack.toLowerCase();
  for (const t of tokens) {
    if (hay.includes(t.toLowerCase())) return t;
  }
  return null;
}

/**
 * Assemble the explainable evidence for a clustered strike. PURE.
 * `fires` is the per-facility FIRMS aggregate (or null if none) — its already-
 * computed `active_now` flag IS the fresh-satellite-heat signal, reused verbatim.
 */
export function buildEvidence(
  cluster: StrikeCluster,
  fires: FireAggregate | null,
  _asOfDate: string,
): StrikeEvidence {
  const sources = cluster.source_urls.map((url) => {
    const domain = domainOf(url);
    return { url, domain, weight: reputationOf(domain) };
  });

  // reputable_count = DISTINCT domains with weight ≥ 1 (two reuters links = 1).
  const reputableDomains = new Set<string>();
  for (const s of sources) {
    if (s.weight >= 1) reputableDomains.add(s.domain);
  }

  const text = cluster.summaries.join(" • ");
  const who = firstMatch(text, ATTRIBUTION_TOKENS);
  const kind = firstMatch(text, CONTRADICTION_TOKENS);
  const trusted_manual = cluster.origins.some((o) => TRUSTED_ORIGINS.has(o));

  return {
    infra_id: cluster.infra_id,
    occurred_on: cluster.occurred_on,
    sources,
    reputable_count: reputableDomains.size,
    satellite: { hit: !!(fires && fires.active_now), last_date: fires?.last_date ?? null },
    attribution: { official: who !== null, who },
    contradiction: { found: kind !== null, kind },
    trusted_manual,
    origins: cluster.origins,
    member_ids: cluster.member_ids,
  };
}

// --- Scoring -----------------------------------------------------------------

/** Days after which a single uncorroborated, satellite-cold strike is demoted. */
export const STALE_DAYS = 5;

export interface Score {
  tier: "confirmed" | "reported" | "single" | "stale" | "retracted";
  score: number;
  breakdown: Record<string, unknown>;
}

// Absolute day difference between two "YYYY-MM-DD" strings (mirrors fires-match's
// utcDaysBetween — kept local so this module stays self-contained + pure).
function utcDaysBetween(a: string, b: string): number {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.abs((da - db) / 86_400_000);
}

/**
 * Deterministic tier + numeric score from assembled evidence. PURE.
 * Priority (first matching rule wins):
 *   1. contradiction.found                                   → 'retracted'
 *   2. trusted_manual
 *      OR (satellite.hit && reputable_count ≥ 2)
 *      OR (satellite.hit && attribution.official && reputable_count ≥ 1) → 'confirmed'
 *   3. reputable_count ≥ 2
 *      OR (reputable_count ≥ 1 && satellite.hit)             → 'reported'
 *   4. reputable_count ≥ 1                                   → 'stale' if aged
 *        > STALE_DAYS && no satellite, else 'single'
 *   5. reputable_count == 0                                  → 'stale'
 */
export function scoreStrike(ev: StrikeEvidence, asOfDate: string): Score {
  const sat = ev.satellite.hit;
  const off = ev.attribution.official;
  const rep = ev.reputable_count;
  const age_days = utcDaysBetween(asOfDate, ev.occurred_on);

  let tier: Score["tier"];
  if (ev.contradiction.found) {
    tier = "retracted";
  } else if (
    ev.trusted_manual ||
    (sat && rep >= 2) ||
    (sat && off && rep >= 1)
  ) {
    tier = "confirmed";
  } else if (rep >= 2 || (rep >= 1 && sat)) {
    tier = "reported";
  } else if (rep >= 1) {
    tier = age_days > STALE_DAYS && !sat ? "stale" : "single";
  } else {
    tier = "stale";
  }

  const score =
    rep * 10 +
    (sat ? 15 : 0) +
    (off ? 8 : 0) +
    (ev.trusted_manual ? 50 : 0) -
    (ev.contradiction.found ? 100 : 0);

  const breakdown: Record<string, unknown> = {
    reputable_count: rep,
    satellite: sat,
    satellite_date: ev.satellite.last_date,
    official_attribution: off,
    who: ev.attribution.who,
    trusted_manual: ev.trusted_manual,
    age_days,
    contradiction: ev.contradiction.found,
    contradiction_kind: ev.contradiction.kind,
    stale_threshold: STALE_DAYS,
  };

  return { tier, score, breakdown };
}
