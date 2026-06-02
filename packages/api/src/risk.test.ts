// Unit tests for the pure risk-scoring logic and recon signal derivation.
// Pure module (no Bun/Postgres deps) — runnable with: node --test packages/api/src/risk.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeRisk,
  flagHopCount,
  vesselAgeYears,
  detectSpoofJumps,
  nmBetween,
  type RiskInputs,
} from "./risk.ts";

const BASE: RiskInputs = {
  sanction_count: 0,
  russia_ukraine_linked: false,
  flag_of_convenience: false,
  ais_dark_minutes: 0,
  longest_gap_min_24h: 0,
  gap_in_suspect_zone_24h: false,
  chain_has_sanctioned_country: false,
};

test("clean vessel scores zero / low", () => {
  const r = computeRisk(BASE);
  assert.equal(r.score, 0);
  assert.equal(r.bucket, "low");
  assert.equal(r.factors.length, 0);
});

test("recon fields are optional and default to no-op", () => {
  // BASE has no recon fields set — must behave identically to before.
  const r = computeRisk(BASE);
  assert.equal(r.score, 0);
});

test("flag-hopping scales and caps at 15", () => {
  assert.equal(computeRisk({ ...BASE, flag_changes_count: 1 }).score, 0); // <2 ignored
  assert.equal(computeRisk({ ...BASE, flag_changes_count: 2 }).score, 10);
  assert.equal(computeRisk({ ...BASE, flag_changes_count: 3 }).score, 15);
  assert.equal(computeRisk({ ...BASE, flag_changes_count: 9 }).score, 15); // cap
});

test("hull age tiers", () => {
  assert.equal(computeRisk({ ...BASE, vessel_age_years: 10 }).score, 0);
  assert.equal(computeRisk({ ...BASE, vessel_age_years: 15 }).score, 5);
  assert.equal(computeRisk({ ...BASE, vessel_age_years: 22 }).score, 10);
  assert.equal(computeRisk({ ...BASE, vessel_age_years: null }).score, 0);
});

test("behaviour + provenance signals each contribute", () => {
  assert.equal(computeRisk({ ...BASE, psc_detained_recently: true }).score, 10);
  assert.equal(computeRisk({ ...BASE, ais_spoofing_suspected: true }).score, 15);
  assert.equal(computeRisk({ ...BASE, loitering_in_zone: true }).score, 10);
  assert.equal(computeRisk({ ...BASE, in_known_case: true }).score, 10);
});

test("score is capped at 100 and bucketed critical", () => {
  const r = computeRisk({
    sanction_count: 10,            // +30 (cap)
    russia_ukraine_linked: true,   // +20
    flag_of_convenience: true,     // +10
    ais_dark_minutes: 120,         // +10
    longest_gap_min_24h: 300,      // +5
    gap_in_suspect_zone_24h: true, // +15
    chain_has_sanctioned_country: true, // +10
    flag_changes_count: 4,         // +15
    vessel_age_years: 25,          // +10
    psc_detained_recently: true,   // +10
    ais_spoofing_suspected: true,  // +15
    loitering_in_zone: true,       // +10
    in_known_case: true,           // +10
  });
  assert.equal(r.score, 100);
  assert.equal(r.bucket, "critical");
});

test("flagHopCount is defensive and de-duplicates", () => {
  assert.equal(flagHopCount(null), 0);
  assert.equal(flagHopCount("panama"), 0);
  assert.equal(flagHopCount([]), 0);
  assert.equal(flagHopCount(["PA", "lr", "MH"]), 3);
  assert.equal(flagHopCount(["pa", "PA", " pa "]), 1); // case/space dedupe
});

test("vesselAgeYears parses YYYY and full dates", () => {
  assert.equal(vesselAgeYears("2005", 2026), 21);
  assert.equal(vesselAgeYears("2005-04-12", 2026), 21);
  assert.equal(vesselAgeYears(null, 2026), null);
  assert.equal(vesselAgeYears("not-a-date", 2026), null);
  assert.equal(vesselAgeYears("1850", 2026), null); // implausible
  assert.equal(vesselAgeYears("2099", 2026), null); // future
});

test("nmBetween ~ known distance (1 deg lat ≈ 60 nm)", () => {
  const d = nmBetween(0, 0, 1, 0);
  assert.ok(Math.abs(d - 60) < 0.5, `expected ~60nm, got ${d}`);
});

test("detectSpoofJumps flags teleports, ignores normal steaming and jitter", () => {
  const track = [
    { lat: 35.0, lon: 20.0, ts: "2026-06-01T00:00:00Z" },
    { lat: 35.1, lon: 20.1, ts: "2026-06-01T01:00:00Z" }, // ~8nm in 1h = 8kn, normal
    { lat: 45.0, lon: 30.0, ts: "2026-06-01T01:30:00Z" }, // huge jump in 30min -> spoof
    { lat: 45.001, lon: 30.001, ts: "2026-06-01T01:31:00Z" }, // tiny jitter -> ignore
  ];
  const jumps = detectSpoofJumps(track);
  assert.equal(jumps.length, 1);
  assert.ok(jumps[0]!.implied_kn > 40);
});
