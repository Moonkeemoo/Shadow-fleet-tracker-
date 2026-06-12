import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reputationOf,
  domainOf,
  buildEvidence,
  scoreStrike,
  STALE_DAYS,
  type StrikeEvidence,
} from "./confidence.ts";
import type { StrikeCluster } from "./strike-cluster.ts";
import type { FireAggregate } from "./fires-match.ts";

const AS_OF = "2026-06-12";

// --- reputationOf / domainOf -------------------------------------------------

test("domainOf strips protocol, www., path, query, fragment, port; lowercases", () => {
  assert.equal(domainOf("https://www.Reuters.com/world/europe/x?y=1#z"), "reuters.com");
  assert.equal(domainOf("HTTP://BBC.CO.UK/news"), "bbc.co.uk");
  assert.equal(domainOf("reuters.com"), "reuters.com");
  assert.equal(domainOf("https://example.com:8080/p"), "example.com");
});

test("reputationOf: known T1 domain → 2", () => {
  assert.equal(reputationOf("reuters.com"), 2);
  assert.equal(reputationOf("https://www.kyivindependent.com/news/x"), 2);
  assert.equal(reputationOf("understandingwar.org"), 2);
  assert.equal(reputationOf("en.defence-ua.com"), 2);
});

test("reputationOf: unknown news-looking domain → 1 (T2 default)", () => {
  assert.equal(reputationOf("some-regional-paper.com"), 1);
  assert.equal(reputationOf("https://news.example.net/a/b"), 1);
});

test("reputationOf: raw social + opaque redirects → 0", () => {
  assert.equal(reputationOf("https://t.me/somechannel"), 0);
  assert.equal(reputationOf("https://twitter.com/u/status/1"), 0);
  assert.equal(reputationOf("https://x.com/u"), 0);
  assert.equal(reputationOf("https://www.youtube.com/watch?v=abc"), 0);
  assert.equal(reputationOf("https://news.google.com/articles/xyz"), 0);
});

test("reputationOf: case-insensitive + www. stripping for T1", () => {
  assert.equal(reputationOf("HTTPS://WWW.REUTERS.COM/x"), 2);
});

// --- buildEvidence -----------------------------------------------------------

function cluster(over: Partial<StrikeCluster> = {}): StrikeCluster {
  return {
    infra_id: "ryazan",
    occurred_on: "2026-06-10",
    member_ids: ["a"],
    origins: ["rss"],
    source_urls: [],
    summaries: [],
    ...over,
  };
}

function fire(over: Partial<FireAggregate> = {}): FireAggregate {
  return {
    count: 3,
    max_frp: 40,
    max_confidence: "h",
    last_date: "2026-06-11",
    active: true,
    active_now: true,
    ...over,
  };
}

test("buildEvidence: reputable_count dedupes by domain (two reuters links = 1)", () => {
  const ev = buildEvidence(
    cluster({ source_urls: ["https://reuters.com/a", "https://reuters.com/b", "https://bbc.com/c"] }),
    null,
    AS_OF,
  );
  assert.equal(ev.reputable_count, 2);
  assert.equal(ev.sources.length, 3);
});

test("buildEvidence: T0 sources do not count toward reputable_count", () => {
  const ev = buildEvidence(
    cluster({ source_urls: ["https://t.me/x", "https://news.google.com/y"] }),
    null,
    AS_OF,
  );
  assert.equal(ev.reputable_count, 0);
});

test("buildEvidence: satellite from active_now=true fire", () => {
  const ev = buildEvidence(cluster(), fire({ active_now: true, last_date: "2026-06-11" }), AS_OF);
  assert.equal(ev.satellite.hit, true);
  assert.equal(ev.satellite.last_date, "2026-06-11");
});

test("buildEvidence: satellite from active_now=false fire → hit false, date preserved", () => {
  const ev = buildEvidence(cluster(), fire({ active_now: false, last_date: "2026-06-05" }), AS_OF);
  assert.equal(ev.satellite.hit, false);
  assert.equal(ev.satellite.last_date, "2026-06-05");
});

test("buildEvidence: null fire → satellite hit false, last_date null", () => {
  const ev = buildEvidence(cluster(), null, AS_OF);
  assert.equal(ev.satellite.hit, false);
  assert.equal(ev.satellite.last_date, null);
});

test("buildEvidence: attribution keyword EN + UA detected, first match wins", () => {
  const en = buildEvidence(cluster({ summaries: ["The SBU claimed the drone strike"] }), null, AS_OF);
  assert.equal(en.attribution.official, true);
  assert.equal(en.attribution.who, "SBU");
  const ua = buildEvidence(cluster({ summaries: ["За даними ГУР, удар підтверджено"] }), null, AS_OF);
  assert.equal(ua.attribution.official, true);
  assert.equal(ua.attribution.who, "ГУР");
});

test("buildEvidence: no attribution keyword → official false, who null", () => {
  const ev = buildEvidence(cluster({ summaries: ["A fire was reported at the refinery"] }), null, AS_OF);
  assert.equal(ev.attribution.official, false);
  assert.equal(ev.attribution.who, null);
});

test("buildEvidence: contradiction keyword EN + UA detected", () => {
  const en = buildEvidence(cluster({ summaries: ["Air defense intercepted the drones, no damage"] }), null, AS_OF);
  assert.equal(en.contradiction.found, true);
  assert.equal(en.contradiction.kind, "intercepted");
  const ua = buildEvidence(cluster({ summaries: ["Інформацію спростовано місцевою владою"] }), null, AS_OF);
  assert.equal(ua.contradiction.found, true);
  assert.equal(ua.contradiction.kind, "спростовано");
});

test("buildEvidence: trusted_manual from manual or curated origin", () => {
  assert.equal(buildEvidence(cluster({ origins: ["manual"] }), null, AS_OF).trusted_manual, true);
  assert.equal(buildEvidence(cluster({ origins: ["curated"] }), null, AS_OF).trusted_manual, true);
  assert.equal(buildEvidence(cluster({ origins: ["rss", "gdelt"] }), null, AS_OF).trusted_manual, false);
});

test("buildEvidence: copies infra_id, occurred_on, origins, member_ids", () => {
  const ev = buildEvidence(
    cluster({ infra_id: "tuapse", occurred_on: "2026-06-01", origins: ["rss", "gdelt"], member_ids: ["a", "b"] }),
    null,
    AS_OF,
  );
  assert.equal(ev.infra_id, "tuapse");
  assert.equal(ev.occurred_on, "2026-06-01");
  assert.deepEqual(ev.origins, ["rss", "gdelt"]);
  assert.deepEqual(ev.member_ids, ["a", "b"]);
});

// --- scoreStrike: tiers ------------------------------------------------------

function ev(over: Partial<StrikeEvidence> = {}): StrikeEvidence {
  return {
    infra_id: "ryazan",
    occurred_on: "2026-06-10",
    sources: [],
    reputable_count: 0,
    satellite: { hit: false, last_date: null },
    attribution: { official: false, who: null },
    contradiction: { found: false, kind: null },
    trusted_manual: false,
    origins: ["rss"],
    member_ids: ["a"],
    ...over,
  };
}

test("retracted: contradiction overrides everything, even satellite + 3 reputable sources", () => {
  const s = scoreStrike(
    ev({
      reputable_count: 3,
      satellite: { hit: true, last_date: "2026-06-11" },
      attribution: { official: true, who: "SBU" },
      trusted_manual: true,
      contradiction: { found: true, kind: "intercepted" },
    }),
    AS_OF,
  );
  assert.equal(s.tier, "retracted");
});

test("confirmed path 1: trusted_manual (no other signals)", () => {
  const s = scoreStrike(ev({ trusted_manual: true }), AS_OF);
  assert.equal(s.tier, "confirmed");
});

test("confirmed path 2: satellite + 2 reputable sources", () => {
  const s = scoreStrike(ev({ reputable_count: 2, satellite: { hit: true, last_date: "2026-06-11" } }), AS_OF);
  assert.equal(s.tier, "confirmed");
});

test("confirmed path 3: satellite + official attribution + 1 reputable source", () => {
  const s = scoreStrike(
    ev({
      reputable_count: 1,
      satellite: { hit: true, last_date: "2026-06-11" },
      attribution: { official: true, who: "GUR" },
    }),
    AS_OF,
  );
  assert.equal(s.tier, "confirmed");
});

test("reported: 2 reputable sources, no satellite", () => {
  const s = scoreStrike(ev({ reputable_count: 2 }), AS_OF);
  assert.equal(s.tier, "reported");
});

test("reported: 1 reputable source + satellite", () => {
  const s = scoreStrike(ev({ reputable_count: 1, satellite: { hit: true, last_date: "2026-06-11" } }), AS_OF);
  assert.equal(s.tier, "reported");
});

test("single: 1 reputable source, fresh (within STALE_DAYS), no satellite", () => {
  const s = scoreStrike(ev({ reputable_count: 1, occurred_on: "2026-06-10" }), AS_OF); // 2 days old
  assert.equal(s.tier, "single");
});

test("single boundary: 1 source aged exactly STALE_DAYS (not >) → single", () => {
  const s = scoreStrike(ev({ reputable_count: 1, occurred_on: "2026-06-07" }), AS_OF); // exactly 5 days
  assert.equal(s.tier, "single");
});

test("stale: 1 source aged > STALE_DAYS, no satellite", () => {
  const s = scoreStrike(ev({ reputable_count: 1, occurred_on: "2026-06-06" }), AS_OF); // 6 days
  assert.equal(s.tier, "stale");
});

test("aged single source but satellite hit → reported, not stale", () => {
  const s = scoreStrike(
    ev({ reputable_count: 1, occurred_on: "2026-06-01", satellite: { hit: true, last_date: "2026-06-11" } }),
    AS_OF,
  );
  assert.equal(s.tier, "reported");
});

test("stale: zero reputable sources (regardless of age)", () => {
  assert.equal(scoreStrike(ev({ reputable_count: 0, occurred_on: AS_OF }), AS_OF).tier, "stale");
  assert.equal(scoreStrike(ev({ reputable_count: 0, occurred_on: "2026-01-01" }), AS_OF).tier, "stale");
});

// --- scoreStrike: score + breakdown ------------------------------------------

test("score is monotone composite of signals", () => {
  const s = scoreStrike(
    ev({
      reputable_count: 2,
      satellite: { hit: true, last_date: "2026-06-11" },
      attribution: { official: true, who: "SBU" },
      trusted_manual: false,
    }),
    AS_OF,
  );
  // 2*10 + 15 + 8 + 0 - 0 = 43
  assert.equal(s.score, 43);
});

test("score: trusted_manual adds 50, contradiction subtracts 100", () => {
  assert.equal(scoreStrike(ev({ trusted_manual: true }), AS_OF).score, 50);
  assert.equal(scoreStrike(ev({ contradiction: { found: true, kind: "denied" } }), AS_OF).score, -100);
});

test("breakdown lists all signals + their values + stale_threshold", () => {
  const s = scoreStrike(
    ev({
      reputable_count: 1,
      occurred_on: "2026-06-10",
      satellite: { hit: true, last_date: "2026-06-11" },
      attribution: { official: true, who: "SBU" },
    }),
    AS_OF,
  );
  assert.deepEqual(s.breakdown, {
    reputable_count: 1,
    satellite: true,
    satellite_date: "2026-06-11",
    official_attribution: true,
    who: "SBU",
    trusted_manual: false,
    age_days: 2,
    contradiction: false,
    contradiction_kind: null,
    stale_threshold: STALE_DAYS,
  });
});

test("idempotent: same evidence + asOfDate → identical Score", () => {
  const e = ev({ reputable_count: 2, satellite: { hit: true, last_date: "2026-06-11" } });
  const a = scoreStrike(e, AS_OF);
  const b = scoreStrike(e, AS_OF);
  assert.deepEqual(a, b);
});

test("STALE_DAYS constant is 5", () => {
  assert.equal(STALE_DAYS, 5);
});
