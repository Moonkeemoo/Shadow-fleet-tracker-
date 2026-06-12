# Automated strike verification — confidence engine (design)

**Date:** 2026-06-12
**Status:** Approved (user). Replaces the manual curator gate with an automated, self-correcting confidence engine.
**Thesis:** The human can't curate the strike firehose. Replace the binary `verified` flag with a **computed confidence tier** that the system recomputes every scheduler cycle — promoting AND demoting/retracting on its own. The human's only remaining job is to *inject strikes they know about that the feeds missed* (recall); the machine owns precision (demotion/retraction). Honesty is preserved: nothing is falsely "verified" — every tier shows the evidence that produced it ("reproducible methodology, all factors explainable").

## Decisions locked (brainstorm)
1. **Auto confidence tiers**, no human in the collection loop.
2. **Full lifecycle**: promote + demote + retract automatically.
3. **Hybrid engine, phased**: Phase 1 deterministic rules own the tier; Phase 2 adds an LLM classifier as a *signal* (denial / on-target), never the decider.
4. **Human role** = manual ADD of known-missing strikes only (a trusted source feeding the same engine). No human rejection UI — the engine demotes false positives itself.

## Tiers (shown honestly on map + feed)
- 🟢 `confirmed` — satellite heat on-facility ±1d AND ≥2 independent reputable sources; OR official UA-agency attribution + ≥1 reputable source + satellite; OR a manual trusted add.
- 🔵 `reported` — ≥2 independent reputable sources, OR (1 reputable source + satellite); no contradiction.
- 🟡 `single` — exactly 1 credible source, no corroboration yet.
- ⚪ `stale` — no 2nd corroborating signal after `STALE_DAYS` (default 5) → demoted.
- 🔴 `retracted` — sources indicate denial / "intercepted" / "no damage" / "debris fell nearby" → kept visible but struck-through, with the contradicting source.

**Grandfather:** existing 256 curated `infra_strikes` + all `military_sites` strikes → `confirmed` (human-verified, ≥2 cited sources each). A manual add enters as a high-weight trusted source → typically `confirmed`/`reported` depending on corroboration.

## Signals (countable + explainable; this IS the project's tagline)
- **Independent source count** — distinct reputable outlets reporting (facility + date ±1d), deduped: same wire republished = 1; Google-News deduped by resolved domain. Reputation allowlist with weights — T1 (Reuters, BBC, Kyiv Independent, Militarnyi, Defense Express, ISW, RFE/RL, Pravda, Euromaidan), T2 (other plausible outlets), T0 (low-trust → ignored). The allowlist lives in one const, easily edited.
- **Satellite corroboration** — FIRMS `active_now`/heat on the facility within ±1 day of the strike date (already computed in fires-match.ts — reuse).
- **Official attribution** — text mentions SBU/GUR/General Staff/SOF/ССО/Генштаб claim. Phase 1: keyword set; Phase 2: LLM.
- **Age** — drives stale demotion.
- **Contradiction** — Phase 1: keyword set (denial/intercepted/no damage/debris fell near/спростовано/перехоплено/без шкоди); Phase 2: LLM classifier. Caps tier / triggers `retracted`.

## Data model
Add to `infra_strikes` (idempotent migration `db/migrate-add-confidence.sql`, house header):
- `confidence_tier TEXT` (one of the 5 tiers; default 'single')
- `confidence_score INT` (numeric score, for ordering/tuning)
- `score_breakdown JSONB` (which signals fired + their weights — powers the "why this tier" tooltip)
- `evidence JSONB` (deduped sources [{url,domain,tier}], satellite{hit,last_date}, attribution{official,who}, cluster member ids/origins)
Keep `verified BOOLEAN` as a **derived/back-compat** column: `verified = (confidence_tier = 'confirmed')`. Existing endpoints/UI reading `verified` keep working; new UI reads `confidence_tier`. Loader inserts keep using `sql.json()` for the JSONB columns (never `JSON.stringify::jsonb`).

## Pure module — `packages/api/src/confidence.ts` (+ heavy unit test)
`scoreStrike(evidence: StrikeEvidence, asOfDate: string): { tier, score, breakdown }` — PURE (no IO, no clock; `asOfDate` passed in, like fires-match's `asOfDate`). Deterministic, exhaustively unit-tested: each tier's promotion rule, stale demotion by age, retraction on contradiction, source dedup-by-domain, reputation weighting, grandfather path (manual/curated trusted source), and that re-running on the same evidence is idempotent.

## Clustering / merge — `packages/api/src/strike-cluster.ts` (+ test)
Today the same strike from RSS and GDELT is two rows. Pure `clusterStrikes(rows): Cluster[]` groups candidate+curated rows by (infra_id, occurred_on ±1 day) into ONE event, unioning their sources/origins into a single `StrikeEvidence`. Pure + tested. The engine scores the *cluster*, not individual rows.

## Engine wiring
- A thin DB step `packages/api/src/cli/rescore.ts` (CLI `bun run rescore`): read recent strikes → cluster → score (asOfDate = today UTC) → write tier/score/breakdown/evidence back (upsert, sql.json). Idempotent; safe to run repeatedly. Mirrors loader idioms (sql.end, structured logs).
- The **scheduler** runs `rescore` as a final step after each feed cycle (so new RSS/GDELT/FIRMS candidates get scored and stale ones demoted automatically). Add it to `scheduler.ts` schedule (after the feeds; cheap, deterministic).

## Manual-add channel
- `POST /api/strikes/manual` (or a tiny CLI) to inject a strike the user knows about: {infra_id, occurred_on, weapon?, severity?, summary, source_urls[]} → inserted as `origin='manual'`, treated by the engine as a **trusted source** (T1-equivalent weight). It still flows through clustering+scoring (so it merges with any matching feed evidence and gets a tier honestly). A minimal UI form is Phase 1-optional (CLI/endpoint is enough to start).

## UI (web/index.html)
- Replace the binary amber "auto·unverified" badge in BOTH the map markers and the feed with **tier chips**: confirmed 🟢/✓, reported 🔵, single 🟡, stale ⚪, retracted 🔴 (struck-through). Reuse the existing chip helpers; retracted rows render with strike-through.
- Facility panel + feed row gain an expandable **"Why this tier"**: the `score_breakdown` rendered as a short list — N sources (linked, by outlet), 🛰 satellite yes/no (date), official attribution yes/no (who), age. This is the explainability payoff.
- `/api/feed` and `/api/infra-strikes` include `confidence_tier` + `score_breakdown`/`evidence` so the UI can render tiers + the breakdown without extra calls.

## Phasing
- **Phase 1 (this spec's implementation target — deterministic, fully shippable):** migration; `confidence.ts` + `strike-cluster.ts` pure modules + tests; `rescore` CLI + scheduler integration; endpoint fields; UI tier chips + "why this tier"; manual-add endpoint/CLI; grandfather existing strikes. No LLM. 100% explainable.
- **Phase 2 (deferred, separate spec/plan):** swap the keyword attribution/contradiction heuristics for a Claude classifier that reads article texts and emits structured signals (denied? on-target vs nearby? severity?) feeding the SAME deterministic engine. Opt-in via env (graceful without an API key, like FIRMS).

## Architecture / testing
- `confidence.ts` and `strike-cluster.ts` are pure + independently unit-tested (the heart of the system — must be deterministic and explainable). The CLI/scheduler/endpoint are thin IO wrappers around them (mirrors the fires-match.ts ↔ load-firms-triggered.ts split).
- Verify: tsc; full test suite green (117 + new); migration applies twice (idempotent); `bun run rescore` clusters+scores the live DB (grandfathered 256 stay `confirmed`, recent RSS/GDELT candidates get sensible tiers, satellite-corroborated ones rise); `/api/feed` + `/api/infra-strikes` carry tiers; UI renders chips + "why this tier"; manual-add injects and scores.

## Out of scope (Phase 1)
LLM classifier (Phase 2); per-source credibility learning/auto-tuning of weights; a full manual-add web form (CLI/endpoint suffices); retroactive re-scoring of military embedded strikes beyond grandfathering; deployment/prod-hardening (separate track).
