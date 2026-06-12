import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterStrikes, type StrikeInput } from "./strike-cluster.ts";

function si(over: Partial<StrikeInput> & { id: string; infra_id: string; occurred_on: string }): StrikeInput {
  return {
    weapon: "uav",
    severity: "unknown",
    summary: "",
    source_urls: [],
    origin: "rss",
    ...over,
  };
}

test("empty input → no clusters", () => {
  assert.deepEqual(clusterStrikes([]), []);
});

test("single row → one cluster", () => {
  const c = clusterStrikes([si({ id: "a", infra_id: "ryazan", occurred_on: "2026-06-10" })]);
  assert.equal(c.length, 1);
  assert.equal(c[0]!.infra_id, "ryazan");
  assert.equal(c[0]!.occurred_on, "2026-06-10");
  assert.deepEqual(c[0]!.member_ids, ["a"]);
});

test("same facility, same date → one cluster", () => {
  const c = clusterStrikes([
    si({ id: "a", infra_id: "ryazan", occurred_on: "2026-06-10" }),
    si({ id: "b", infra_id: "ryazan", occurred_on: "2026-06-10" }),
  ]);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0]!.member_ids, ["a", "b"]);
});

test("same facility ±1 day → one cluster", () => {
  const c = clusterStrikes([
    si({ id: "a", infra_id: "ryazan", occurred_on: "2026-06-10" }),
    si({ id: "b", infra_id: "ryazan", occurred_on: "2026-06-11" }),
  ]);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0]!.member_ids.sort(), ["a", "b"]);
});

test("same facility 5 days apart → separate clusters", () => {
  const c = clusterStrikes([
    si({ id: "a", infra_id: "ryazan", occurred_on: "2026-06-10" }),
    si({ id: "b", infra_id: "ryazan", occurred_on: "2026-06-15" }),
  ]);
  assert.equal(c.length, 2);
  assert.equal(c[0]!.occurred_on, "2026-06-10");
  assert.equal(c[1]!.occurred_on, "2026-06-15");
});

test("different facilities never merge (even same date)", () => {
  const c = clusterStrikes([
    si({ id: "a", infra_id: "ryazan", occurred_on: "2026-06-10" }),
    si({ id: "b", infra_id: "tuapse", occurred_on: "2026-06-10" }),
  ]);
  assert.equal(c.length, 2);
  const ids = c.map((x) => x.infra_id).sort();
  assert.deepEqual(ids, ["ryazan", "tuapse"]);
});

test("transitive 3-day run all merges into one cluster (documented behavior)", () => {
  const c = clusterStrikes([
    si({ id: "a", infra_id: "ryazan", occurred_on: "2026-06-08" }),
    si({ id: "b", infra_id: "ryazan", occurred_on: "2026-06-09" }),
    si({ id: "c", infra_id: "ryazan", occurred_on: "2026-06-10" }),
  ]);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0]!.member_ids.sort(), ["a", "b", "c"]);
});

test("canonical occurred_on = earliest member date (regardless of input order)", () => {
  const c = clusterStrikes([
    si({ id: "late", infra_id: "ryazan", occurred_on: "2026-06-11" }),
    si({ id: "early", infra_id: "ryazan", occurred_on: "2026-06-10" }),
  ]);
  assert.equal(c.length, 1);
  assert.equal(c[0]!.occurred_on, "2026-06-10");
});

test("union + dedup of member_ids, origins, source_urls; collect summaries", () => {
  const c = clusterStrikes([
    si({
      id: "a",
      infra_id: "ryazan",
      occurred_on: "2026-06-10",
      origin: "rss",
      source_urls: ["https://reuters.com/x", "https://bbc.com/y"],
      summary: "strike on ryazan",
    }),
    si({
      id: "b",
      infra_id: "ryazan",
      occurred_on: "2026-06-11",
      origin: "gdelt",
      source_urls: ["https://reuters.com/x", "https://militarnyi.com/z"], // reuters dup
      summary: "fire confirmed",
    }),
    si({
      id: "a", // duplicate id
      infra_id: "ryazan",
      occurred_on: "2026-06-10",
      origin: "rss", // duplicate origin
      source_urls: ["https://bbc.com/y"], // duplicate url
      summary: "strike on ryazan", // collected (not deduped) — summaries keep all
    }),
  ]);
  assert.equal(c.length, 1);
  const cl = c[0]!;
  assert.deepEqual(cl.member_ids, ["a", "b"]);
  assert.deepEqual(cl.origins, ["rss", "gdelt"]);
  assert.deepEqual(cl.source_urls, ["https://reuters.com/x", "https://bbc.com/y", "https://militarnyi.com/z"]);
  // summaries collected (3 rows had non-empty summaries; the empty-string default is skipped)
  assert.equal(cl.summaries.length, 3);
});

test("empty summary strings are not collected", () => {
  const c = clusterStrikes([
    si({ id: "a", infra_id: "ryazan", occurred_on: "2026-06-10", summary: "" }),
    si({ id: "b", infra_id: "ryazan", occurred_on: "2026-06-10", summary: "real" }),
  ]);
  assert.deepEqual(c[0]!.summaries, ["real"]);
});

test("deterministic: shuffled input yields identical clustering", () => {
  const rows = [
    si({ id: "a", infra_id: "ryazan", occurred_on: "2026-06-10" }),
    si({ id: "b", infra_id: "tuapse", occurred_on: "2026-06-10" }),
    si({ id: "c", infra_id: "ryazan", occurred_on: "2026-06-11" }),
    si({ id: "d", infra_id: "ryazan", occurred_on: "2026-06-20" }),
  ];
  const a = clusterStrikes(rows);
  const b = clusterStrikes([...rows].reverse());
  assert.deepEqual(a, b);
  // ryazan: {a,c} merged, {d} separate; tuapse: {b} → 3 clusters
  assert.equal(a.length, 3);
});
