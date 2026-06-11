# Military-industrial layer — design

**Date:** 2026-06-11
**Status:** Approved (user). Scope: key war-relevant production (~50–80 sites), struck + not;
strikes embedded per site.
**Thesis:** add Russia's defence-industrial complex as a map layer — what each plant makes,
who runs it, and whether (and when) it has been struck — same curated/cited ethos as oil-infra.

## Data — `data/military-sites.json` (curated, every fact cited)
```
{ "sites": [ {
  "id": "kebab-case-id",
  "name": "English name",
  "name_local": "русское название" | null,
  "lat": number, "lon": number,
  "category": "drone" | "missile" | "ammunition" | "explosives" | "armor"
             | "aviation" | "electronics" | "shipyard" | "other",
  "produces": "1-line what it makes (e.g. 'Shahed/Geran-2 attack drones')",
  "operator": "holding/owner (Rostec / Almaz-Antey / UAC / Kalashnikov / ...)" | null,
  "region": "oblast/krai" | null,
  "status": "operational" | "damaged" | "destroyed" | "unknown",
  "strikes": [ { "occurred_on": "YYYY-MM-DD", "weapon": "uav"|"missile"|"sabotage"|"unknown",
                 "severity": "major"|"moderate"|"minor"|"unknown",
                 "summary": "1-2 sentences", "source_urls": ["..."] } ],
  "notes": "short note" | null,
  "source_urls": ["site-level sources: existence / what it produces"]   // >=1
} ] }
```
- `struck` is **derived** (`strikes.length > 0`) — not stored in the file.
- Target ~50–80 strategically significant production sites across the categories, BOTH struck
  and not struck. Anchors: Alabuga (Shahed/Geran), Izhevsk (drones/Kalashnikov), Votkinsk
  (Iskander/ballistic), MKB Raduga (cruise missiles), Uralvagonzavod (tanks), UAC plants
  (Komsomolsk/Novosibirsk aviation), powder/ammunition (Sverdlov, Kazan/Tambov powder),
  electronics/optics, JSC shipyards. Each site ≥1 source; each strike ≥1 source.
- Honesty: existence/profile from public OSINT/press; each strike cited; "struck/not struck"
  reflects **publicly reported** strikes only (absence ≠ confirmed never hit — stated in the
  panel + methodology).

## Pure module — `packages/api/src/military-normalize.ts` (+ test)
`normalizeMilitarySite(raw): MilitarySite | null`:
- reject if missing id/name, or lat/lon out of range, or no valid http(s) `source_urls`.
- `category` ∈ the 9 values else "other"; `status` ∈ the 4 else "unknown".
- `strikes`: array; each strike normalized (occurred_on real calendar date via the shared
  `toIsoDate` helper reused from infra-normalize; weapon ∈ 4 else "unknown"; severity ∈ 4 else
  "unknown"; source_urls ≥1 http(s) else drop that strike). `struck` derived on read.
- Reuse helpers (toStr/toNum/toIsoDate/url-check) — extract/share with infra-normalize if clean,
  else mirror minimally. Unit test: valid site; bad coords/sources rejected; bad category→other;
  strike date/weapon/severity validation; struck derivation.

## Backend
- Migration `db/migrate-add-military.sql` (idempotent, house header): table `military_sites`
  (id TEXT PK, name, name_local, lat REAL, lon REAL, category TEXT, produces TEXT, operator TEXT,
  region TEXT, status TEXT, strikes JSONB, notes TEXT, source_urls TEXT[], raw JSONB,
  first_seen TIMESTAMPTZ DEFAULT NOW()); index on category.
- Loader `packages/api/src/cli/load-military.ts` (mirror load-infra): parse {sites}, ensureTable,
  normalize, upsert ON CONFLICT (id), **sql.json** for strikes + raw (never stringify+::jsonb).
  package.json script `load-military`. reconTables gains `military` flag.
- `GET /api/military` (cache 600_000; `?category=` filter; graceful `{available:false}` / note
  when table absent). Returns sites incl. parsed `strikes` array + derived `struck`
  (`COALESCE(jsonb_array_length(strikes),0) > 0`).

## UI (web/index.html)
- Chip `🎯 Military` after the Fires chip; `militaryLayer` LayerGroup; `layerVisible.military`;
  toggle wiring. Boot fetch `loadMilitary()` (static — no interval).
- **Markers**: a military icon (e.g. a small shield/star divIcon) colored by category
  (`MIL_COLORS` map). Struck sites carry the same **freshness badge** as infra (red shades by
  most-recent strike recency via the existing `freshnessBadge`/`daysSinceUTC`; glow when ≤7d) +
  the 🔥 burning overlay reuse is N/A here (no FIRMS join for military v1) — just the badge.
  Tooltip: `name · produces · (N strikes / not struck)`.
- **Panel** `openMilitaryPanel(s)`: Profile (category label, local name, produces, operator,
  region, status, coordinates) → "Struck?" line → **Strike history** (numbered `attackEntry`
  entries with weapon + severity chips, newest first; "no recorded strikes" when empty) →
  Notes → Sources. Reuse `attackEntry`, `strikeChip`, `freshnessBadge`, `relativeAge`,
  `escapeHtml`, `sourceLinks`, the severity/ weapon chip helpers.
- Legend: a `🎯 military site` entry.

## Docs
- methodology.html: source-provenance row (military-industrial OSINT/press, cited per record;
  "publicly-reported strikes only — absence ≠ never hit") + a sentence in the layers section.
- README: feature bullet + `load-military` command + data-sources row + repo-layout entry.

## Architecture / testing
- military-normalize.ts pure + unit-tested (reuses infra-normalize's `toIsoDate`). No FIRMS/Impact
  integration in v1 (embedded strikes per site; can integrate into Impact later).
- Verify: tsc; bun run test (66 + new); migration applies; `bun run load-military` loads the
  research file; `curl /api/military` + `?category=drone`; UI markers + panel render; struck
  badges show; headless no console errors.

## Out of scope (v1)
Normalized military_strikes table / Impact-page + FIRMS integration (strikes stay embedded);
broad full-OPK coverage (phased); brand rename (OilFront naming — separate decision later).
