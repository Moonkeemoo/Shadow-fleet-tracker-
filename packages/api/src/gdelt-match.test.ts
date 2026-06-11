// Unit tests for the pure GDELT article → strike-candidate logic.
// Pure module (no Bun/Postgres deps) — runnable with: node --test packages/api/src/gdelt-match.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGdeltQuery,
  isStrikeArticle,
  mapGdeltArticle,
  type GdeltArticle,
} from "./gdelt-match.ts";

function makeArticle(overrides: Partial<GdeltArticle> = {}): GdeltArticle {
  return {
    url: "https://example.com/news/refinery-strike",
    title: "Drone strike hits Ryazan oil refinery overnight",
    seendate: "20260611T063000Z",
    domain: "example.com",
    ...overrides,
  };
}

test("buildGdeltQuery without local name quotes the facility name", () => {
  const q = buildGdeltQuery("Ryazan Refinery", null);
  assert.equal(q, '"Ryazan Refinery" (strike OR drone OR attack OR fire OR explosion)');
});

test("buildGdeltQuery with local name produces an OR-group of both names", () => {
  const q = buildGdeltQuery("Ryazan Refinery", "Рязанский НПЗ");
  assert.equal(q, '("Ryazan Refinery" OR "Рязанский НПЗ") (strike OR drone OR attack OR fire OR explosion)');
});

test("isStrikeArticle matches latin strike vocabulary", () => {
  assert.equal(isStrikeArticle("Drone strike hits Ryazan refinery"), true);
  assert.equal(isStrikeArticle("Explosion and fire reported at oil depot"), true);
  assert.equal(isStrikeArticle("Facility damaged after overnight attack"), true);
});

test("isStrikeArticle matches cyrillic strike vocabulary", () => {
  assert.equal(isStrikeArticle("Удар по НПЗ: пожар на территории завода"), true);
  assert.equal(isStrikeArticle("Атака БпЛА на нефтебазу"), true);
  assert.equal(isStrikeArticle("Дрони атакували завод, спалахнула пожежа"), true);
});

test("isStrikeArticle rejects non-strike headlines", () => {
  assert.equal(isStrikeArticle("Oil prices rise"), false);
  assert.equal(isStrikeArticle("Refinery posts record quarterly output"), false);
});

test("mapGdeltArticle parses full seendate format YYYYMMDDTHHMMSSZ", () => {
  const c = mapGdeltArticle(makeArticle({ seendate: "20260611T063000Z" }), "ryazan-refinery");
  assert.ok(c);
  assert.equal(c.occurred_on, "2026-06-11");
});

test("mapGdeltArticle parses plain YYYYMMDD seendate prefix", () => {
  const c = mapGdeltArticle(makeArticle({ seendate: "20260530" }), "ryazan-refinery");
  assert.ok(c);
  assert.equal(c.occurred_on, "2026-05-30");
});

test("mapGdeltArticle returns null for invalid seendate", () => {
  assert.equal(mapGdeltArticle(makeArticle({ seendate: "not-a-date" }), "ryazan-refinery"), null);
  assert.equal(mapGdeltArticle(makeArticle({ seendate: "2026-06-11" }), "ryazan-refinery"), null);
  assert.equal(mapGdeltArticle(makeArticle({ seendate: "20261399T000000Z" }), "ryazan-refinery"), null);
  assert.equal(mapGdeltArticle(makeArticle({ seendate: "" }), "ryazan-refinery"), null);
});

test("mapGdeltArticle rejects non-http urls", () => {
  assert.equal(mapGdeltArticle(makeArticle({ url: "ftp://example.com/x" }), "ryazan-refinery"), null);
  assert.equal(mapGdeltArticle(makeArticle({ url: "javascript:alert(1)" }), "ryazan-refinery"), null);
  assert.equal(mapGdeltArticle(makeArticle({ url: "" }), "ryazan-refinery"), null);
  assert.ok(mapGdeltArticle(makeArticle({ url: "http://example.com/x" }), "ryazan-refinery"));
});

test("weapon maps to uav for drone/UAV/БпЛА/дрон titles, else unknown", () => {
  assert.equal(mapGdeltArticle(makeArticle({ title: "Drone strike on refinery" }), "r1")?.weapon, "uav");
  assert.equal(mapGdeltArticle(makeArticle({ title: "UAV attack reported" }), "r1")?.weapon, "uav");
  assert.equal(mapGdeltArticle(makeArticle({ title: "Атака БпЛА на НПЗ" }), "r1")?.weapon, "uav");
  assert.equal(mapGdeltArticle(makeArticle({ title: "Дрони вдарили по заводу" }), "r1")?.weapon, "uav");
  assert.equal(mapGdeltArticle(makeArticle({ title: "Explosion at oil depot" }), "r1")?.weapon, "unknown");
});

test("candidate id is gdelt-<infra_id>-<YYYYMMDD> — one per facility per day", () => {
  const c = mapGdeltArticle(makeArticle({ seendate: "20260611T063000Z" }), "ryazan-refinery");
  assert.ok(c);
  assert.equal(c.id, "gdelt-ryazan-refinery-20260611");
  assert.equal(c.infra_id, "ryazan-refinery");
  // same facility + same day from a different article → same id
  const c2 = mapGdeltArticle(
    makeArticle({ seendate: "20260611T220000Z", url: "https://other.example/y", title: "Fire at refinery" }),
    "ryazan-refinery",
  );
  assert.equal(c2?.id, c.id);
});

test("summary is trimmed to 280 chars and suffixed with [auto: GDELT]", () => {
  const long = "y".repeat(400);
  const c = mapGdeltArticle(makeArticle({ title: long }), "r1");
  assert.ok(c);
  assert.equal(c.summary, "y".repeat(280) + " [auto: GDELT]");
  const short = mapGdeltArticle(makeArticle({ title: "  Short headline.  " }), "r1");
  assert.equal(short?.summary, "Short headline. [auto: GDELT]");
});

test("substring noise does not trigger strike detection", () => {
  assert.equal(isStrikeArticle("Ceasefire talks continue in region"), false);
  assert.equal(isStrikeArticle("Wildfire near architecture museum"), false);
  assert.equal(isStrikeArticle("Refinery hit by drone"), true);
});

test("source_urls carries the article url and raw preserves the article", () => {
  const a = makeArticle();
  const c = mapGdeltArticle(a, "ryazan-refinery");
  assert.ok(c);
  assert.deepEqual(c.source_urls, [a.url]);
  assert.equal(c.raw.domain, "example.com");
  assert.equal(c.raw.title, a.title);
});
