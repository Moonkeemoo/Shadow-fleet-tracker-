-- Adds the military_sites table: Russian military-industrial facilities
-- (drone plants, missile factories, ammunition depots, armour/electronics
-- producers, shipyards, aviation works, etc.) relevant to the Ukraine war.
-- Powers the /api/military endpoint and the "Military" map layer in the UI.
-- Data: data/military-sites.json (58 curated, source-cited records).
-- Spec: docs/superpowers/specs/2026-06-11-military-layer-design.md
--
-- Idempotent. Run via:
--   docker compose exec -T postgres psql -U shadow -d shadow < db/migrate-add-military.sql
-- The loader (load-military.ts) also creates this table on first run,
-- so a separate migration step is optional.

CREATE TABLE IF NOT EXISTS military_sites (
  id          TEXT PRIMARY KEY,       -- stable kebab-case slug
  name        TEXT NOT NULL,
  name_local  TEXT,
  lat         REAL,
  lon         REAL,
  category    TEXT,                   -- 'drone' | 'missile' | 'ammunition' | 'explosives' | 'armor' | 'aviation' | 'electronics' | 'shipyard' | 'other'
  produces    TEXT,
  operator    TEXT,
  region      TEXT,
  status      TEXT,                   -- 'operational' | 'damaged' | 'destroyed' | 'unknown'
  strikes     JSONB,                  -- array of MilitaryStrike objects
  notes       TEXT,
  source_urls TEXT[],
  raw         JSONB,
  first_seen  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS military_sites_category_idx ON military_sites (category);
