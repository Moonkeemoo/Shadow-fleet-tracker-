// Unit tests for the pure military-site normalization.
// Pure module (no Bun/Postgres deps) — runnable with: node --test packages/api/src/military-normalize.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMilitarySite, isStruck } from "./military-normalize.ts";

const SITE = {
  id: "alabuga-sez",
  name: "Alabuga SEZ (Shahed/Geran plant)",
  name_local: "ОЭЗ «Алабуга»",
  lat: 55.73,
  lon: 52.37,
  category: "drone",
  produces: "Shahed/Geran-2 attack drones",
  operator: "Rostec",
  region: "Tatarstan",
  status: "operational",
  strikes: [],
  notes: null,
  source_urls: ["https://www.reuters.com/alabuga-example"],
};

// --- Valid site passes through ---
test("valid site normalizes correctly", () => {
  const s = normalizeMilitarySite(SITE);
  assert.ok(s);
  assert.equal(s.id, "alabuga-sez");
  assert.equal(s.name, "Alabuga SEZ (Shahed/Geran plant)");
  assert.equal(s.name_local, "ОЭЗ «Алабуга»");
  assert.equal(s.lat, 55.73);
  assert.equal(s.lon, 52.37);
  assert.equal(s.category, "drone");
  assert.equal(s.produces, "Shahed/Geran-2 attack drones");
  assert.equal(s.operator, "Rostec");
  assert.equal(s.region, "Tatarstan");
  assert.equal(s.status, "operational");
  assert.deepEqual(s.strikes, []);
  assert.deepEqual(s.source_urls, ["https://www.reuters.com/alabuga-example"]);
  assert.strictEqual(s.raw, SITE);
});

// --- Missing id/name rejected ---
test("missing id is rejected", () => {
  assert.equal(normalizeMilitarySite({ ...SITE, id: null }), null);
  assert.equal(normalizeMilitarySite({ ...SITE, id: "" }), null);
  assert.equal(normalizeMilitarySite({ ...SITE, id: undefined }), null);
});

test("missing name is rejected", () => {
  assert.equal(normalizeMilitarySite({ ...SITE, name: null }), null);
  assert.equal(normalizeMilitarySite({ ...SITE, name: "" }), null);
  assert.equal(normalizeMilitarySite({ ...SITE, name: undefined }), null);
});

// --- Bad coords rejected ---
test("out-of-range lat is rejected", () => {
  assert.equal(normalizeMilitarySite({ ...SITE, lat: 91 }), null);
  assert.equal(normalizeMilitarySite({ ...SITE, lat: -91 }), null);
  assert.equal(normalizeMilitarySite({ ...SITE, lat: null }), null);
});

test("out-of-range lon is rejected", () => {
  assert.equal(normalizeMilitarySite({ ...SITE, lon: 181 }), null);
  assert.equal(normalizeMilitarySite({ ...SITE, lon: -181 }), null);
  assert.equal(normalizeMilitarySite({ ...SITE, lon: null }), null);
});

// --- Missing/empty source_urls rejected ---
test("missing or empty source_urls is rejected", () => {
  assert.equal(normalizeMilitarySite({ ...SITE, source_urls: [] }), null);
  assert.equal(normalizeMilitarySite({ ...SITE, source_urls: ["not-a-url"] }), null);
  assert.equal(normalizeMilitarySite({ ...SITE, source_urls: null }), null);
});

// --- Category fallback ---
test("bad category falls back to 'other'", () => {
  const s = normalizeMilitarySite({ ...SITE, category: "nuclear" });
  assert.ok(s);
  assert.equal(s.category, "other");
});

test("absent category falls back to 'other'", () => {
  const s = normalizeMilitarySite({ ...SITE, category: null });
  assert.ok(s);
  assert.equal(s.category, "other");
});

test("all valid categories pass through", () => {
  for (const cat of ["drone", "missile", "ammunition", "explosives", "armor", "aviation", "electronics", "shipyard", "other"]) {
    const s = normalizeMilitarySite({ ...SITE, category: cat });
    assert.ok(s, `category ${cat} should be accepted`);
    assert.equal(s.category, cat);
  }
});

// --- Status fallback ---
test("bad status falls back to 'unknown'", () => {
  const s = normalizeMilitarySite({ ...SITE, status: "thriving" });
  assert.ok(s);
  assert.equal(s.status, "unknown");
});

test("absent status falls back to 'unknown'", () => {
  const s = normalizeMilitarySite({ ...SITE, status: null });
  assert.ok(s);
  assert.equal(s.status, "unknown");
});

test("all valid statuses pass through", () => {
  for (const st of ["operational", "damaged", "destroyed", "unknown"]) {
    const s = normalizeMilitarySite({ ...SITE, status: st });
    assert.ok(s, `status ${st} should be accepted`);
    assert.equal(s.status, st);
  }
});

// --- Strike: invalid date dropped ---
test("strike with invalid date is dropped", () => {
  const raw = {
    ...SITE,
    strikes: [
      { occurred_on: "not-a-date", weapon: "uav", severity: "major", source_urls: ["https://example.com/s1"] },
      { occurred_on: "2024-03-13", weapon: "uav", severity: "major", source_urls: ["https://example.com/s2"] },
    ],
  };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(s.strikes.length, 1);
  assert.equal(s.strikes[0]!.occurred_on, "2024-03-13");
});

test("strike with impossible calendar date is dropped", () => {
  const raw = {
    ...SITE,
    strikes: [
      { occurred_on: "2024-13-45", weapon: "uav", severity: "major", source_urls: ["https://example.com/s1"] },
    ],
  };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(s.strikes.length, 0);
});

test("strike with missing date is dropped", () => {
  const raw = {
    ...SITE,
    strikes: [
      { occurred_on: null, weapon: "uav", severity: "major", source_urls: ["https://example.com/s1"] },
    ],
  };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(s.strikes.length, 0);
});

// --- Strike: no valid source_urls drops that strike ---
test("strike without valid source_urls is dropped", () => {
  const raw = {
    ...SITE,
    strikes: [
      { occurred_on: "2024-03-13", weapon: "uav", severity: "major", source_urls: [] },
      { occurred_on: "2024-03-14", weapon: "uav", severity: "moderate", source_urls: ["https://example.com/valid"] },
    ],
  };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(s.strikes.length, 1);
  assert.equal(s.strikes[0]!.occurred_on, "2024-03-14");
});

test("strike with non-http source_url is dropped", () => {
  const raw = {
    ...SITE,
    strikes: [
      { occurred_on: "2024-03-13", weapon: "uav", severity: "major", source_urls: ["ftp://example.com/s1"] },
    ],
  };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(s.strikes.length, 0);
});

// --- Strike: weapon fallback ---
test("unknown weapon falls back to 'unknown'", () => {
  const raw = {
    ...SITE,
    strikes: [
      { occurred_on: "2024-03-13", weapon: "ballista", severity: "major", source_urls: ["https://example.com/s1"] },
    ],
  };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(s.strikes[0]!.weapon, "unknown");
});

test("absent weapon falls back to 'unknown'", () => {
  const raw = {
    ...SITE,
    strikes: [
      { occurred_on: "2024-03-13", severity: "major", source_urls: ["https://example.com/s1"] },
    ],
  };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(s.strikes[0]!.weapon, "unknown");
});

// --- Strike: severity fallback ---
test("unknown severity falls back to 'unknown'", () => {
  const raw = {
    ...SITE,
    strikes: [
      { occurred_on: "2024-03-13", weapon: "uav", severity: "catastrophic", source_urls: ["https://example.com/s1"] },
    ],
  };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(s.strikes[0]!.severity, "unknown");
});

test("absent severity falls back to 'unknown'", () => {
  const raw = {
    ...SITE,
    strikes: [
      { occurred_on: "2024-03-13", weapon: "uav", source_urls: ["https://example.com/s1"] },
    ],
  };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(s.strikes[0]!.severity, "unknown");
});

// --- All valid strike weapons pass through (military-specific, unlike infra) ---
test("all valid strike weapons pass through", () => {
  for (const weapon of ["uav", "missile", "sabotage", "unknown"]) {
    const raw = {
      ...SITE,
      strikes: [
        { occurred_on: "2024-03-13", weapon, severity: "major", source_urls: ["https://example.com/s1"] },
      ],
    };
    const s = normalizeMilitarySite(raw);
    assert.ok(s, `weapon ${weapon} should be accepted`);
    assert.equal(s.strikes[0]!.weapon, weapon);
  }
});

// --- isStruck derivation ---
test("isStruck returns false with no strikes", () => {
  const s = normalizeMilitarySite({ ...SITE, strikes: [] });
  assert.ok(s);
  assert.equal(isStruck(s), false);
});

test("isStruck returns true with ≥1 valid strike", () => {
  const raw = {
    ...SITE,
    strikes: [
      { occurred_on: "2024-03-13", weapon: "uav", severity: "major", source_urls: ["https://example.com/s1"] },
    ],
  };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(isStruck(s), true);
});

test("isStruck is false when all strikes are dropped (bad dates/sources)", () => {
  const raw = {
    ...SITE,
    strikes: [
      { occurred_on: "not-a-date", weapon: "uav", severity: "major", source_urls: ["https://example.com/s1"] },
      { occurred_on: "2024-03-13", weapon: "uav", severity: "major", source_urls: [] },
    ],
  };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(isStruck(s), false);
});

// --- nullable optional string fields ---
test("nullable optional fields pass through correctly", () => {
  const raw = { ...SITE, name_local: null, produces: null, operator: null, region: null, notes: null };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(s.name_local, null);
  assert.equal(s.produces, null);
  assert.equal(s.operator, null);
  assert.equal(s.region, null);
  assert.equal(s.notes, null);
});

// --- strikes array is absent or not array → treated as empty ---
test("absent strikes field normalizes to empty array", () => {
  const raw = { ...SITE };
  delete (raw as Record<string, unknown>).strikes;
  const s = normalizeMilitarySite(raw as Record<string, unknown>);
  assert.ok(s);
  assert.deepEqual(s.strikes, []);
});

test("non-object strike entries (null, string, number) are dropped", () => {
  const raw = { ...SITE, strikes: [null, "x", 42] };
  const s = normalizeMilitarySite(raw as Record<string, unknown>);
  assert.ok(s);
  assert.deepEqual(s.strikes, []);
});

// --- strike with summary passes through ---
test("strike summary is preserved", () => {
  const raw = {
    ...SITE,
    strikes: [
      { occurred_on: "2024-03-13", weapon: "uav", severity: "major", summary: "Drone struck the facility.", source_urls: ["https://example.com/s1"] },
    ],
  };
  const s = normalizeMilitarySite(raw);
  assert.ok(s);
  assert.equal(s.strikes[0]!.summary, "Drone struck the facility.");
});
