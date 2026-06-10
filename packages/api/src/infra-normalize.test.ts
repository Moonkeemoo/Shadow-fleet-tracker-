// Unit tests for the pure infra/attack record normalization.
// Pure module (no Bun/Postgres deps) — runnable with: node --test packages/api/src/infra-normalize.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInfra, normalizeAttack } from "./infra-normalize.ts";

const REFINERY = {
  id: "ryazan-refinery",
  kind: "refinery",
  name: "Ryazan Oil Refinery",
  name_local: "Рязанский НПЗ",
  lat: 54.56, lon: 39.79,
  geometry: null,
  commodity: null,
  capacity_mt_yr: 17.1, capacity_bbl_d: null,
  storage_m3: null, throughput_mt_yr: null,
  owner: "Rosneft", operator: null, region: "Ryazan Oblast",
  status: "operational", notes: null,
  source_urls: ["https://example.org/ryazan"],
};

test("valid refinery normalizes", () => {
  const r = normalizeInfra(REFINERY);
  assert.ok(r);
  assert.equal(r.id, "ryazan-refinery");
  assert.equal(r.kind, "refinery");
  assert.equal(r.lat, 54.56);
  assert.equal(r.status, "operational");
  assert.deepEqual(r.source_urls, ["https://example.org/ryazan"]);
});

test("point object without coordinates is rejected", () => {
  assert.equal(normalizeInfra({ ...REFINERY, lat: null }), null);
});

test("record without sources is rejected — every record must be cited", () => {
  assert.equal(normalizeInfra({ ...REFINERY, source_urls: [] }), null);
  assert.equal(normalizeInfra({ ...REFINERY, source_urls: ["not-a-url"] }), null);
});

test("unknown kind is rejected", () => {
  assert.equal(normalizeInfra({ ...REFINERY, kind: "powerplant" }), null);
});

test("bogus status falls back to unknown", () => {
  const r = normalizeInfra({ ...REFINERY, status: "thriving" });
  assert.ok(r);
  assert.equal(r.status, "unknown");
});

test("pipeline requires geometry instead of lat/lon", () => {
  const pipe = {
    ...REFINERY,
    id: "bts-2", kind: "pipeline", name: "BTS-2",
    lat: null, lon: null, commodity: "crude",
    geometry: { type: "LineString", coordinates: [[34.3, 53.2], [28.4, 59.66]] },
  };
  const r = normalizeInfra(pipe);
  assert.ok(r);
  assert.equal(r.kind, "pipeline");
  assert.ok(r.geometry);
  assert.equal(normalizeInfra({ ...pipe, geometry: null }), null);
});

const ATTACK = {
  id: "2023-08-05-sig",
  occurred_on: "2023-08-05",
  vessel_name: "SIG",
  imo: 9735335,
  lat: 44.8, lon: 36.7,
  location_precision: "approx",
  attack_type: "usv_strike",
  summary: "Ukrainian naval drone struck the tanker SIG near the Kerch Strait.",
  source_urls: ["https://www.reuters.com/example"],
};

test("valid attack normalizes", () => {
  const a = normalizeAttack(ATTACK);
  assert.ok(a);
  assert.equal(a.id, "2023-08-05-sig");
  assert.equal(a.imo, 9735335);
  assert.equal(a.attack_type, "usv_strike");
});

test("attack with bad date is rejected", () => {
  assert.equal(normalizeAttack({ ...ATTACK, occurred_on: "August 2023" }), null);
  assert.equal(normalizeAttack({ ...ATTACK, occurred_on: null }), null);
});

test("attack without coordinates or sources is rejected", () => {
  assert.equal(normalizeAttack({ ...ATTACK, lat: null }), null);
  assert.equal(normalizeAttack({ ...ATTACK, source_urls: [] }), null);
});

test("attack with invalid type is rejected, bad precision falls back to approx", () => {
  assert.equal(normalizeAttack({ ...ATTACK, attack_type: "torpedo" }), null);
  const a = normalizeAttack({ ...ATTACK, location_precision: "fuzzy" });
  assert.ok(a);
  assert.equal(a.location_precision, "approx");
});

test("non-7-digit IMO becomes null", () => {
  const a = normalizeAttack({ ...ATTACK, imo: 12345 });
  assert.ok(a);
  assert.equal(a.imo, null);
});

// --- Fix 1: out-of-range coordinate bounds ---
test("out-of-range lat rejected for infra", () => {
  assert.equal(normalizeInfra({ ...REFINERY, lat: 999 }), null);
});

test("out-of-range lon rejected for attack", () => {
  assert.equal(normalizeAttack({ ...ATTACK, lon: 200 }), null);
});

// --- Fix 2: impossible calendar date rejected ---
test("impossible calendar date rejected for attack", () => {
  assert.equal(normalizeAttack({ ...ATTACK, occurred_on: "2023-13-45" }), null);
});

// --- Fix 3: string coordinates coerce to number ---
test("string coordinates coerce to number for infra", () => {
  const r = normalizeInfra({ ...REFINERY, lat: "54.56", lon: "39.79" });
  assert.ok(r);
  assert.equal(r.lat, 54.56);
});

// --- Fix 4: geometry as array treated as null → pipeline rejected ---
test("geometry as array treated as null → pipeline rejected", () => {
  const pipe = {
    ...REFINERY,
    id: "bts-2", kind: "pipeline", name: "BTS-2",
    lat: null, lon: null, commodity: "crude",
    geometry: [[34.3, 53.2]],
  };
  assert.equal(normalizeInfra(pipe), null);
});

// --- Fix 5: float IMO truncates ---
test("float IMO truncates to integer", () => {
  const a = normalizeAttack({ ...ATTACK, imo: 9735335.7 });
  assert.ok(a);
  assert.equal(a.imo, 9735335);
});
