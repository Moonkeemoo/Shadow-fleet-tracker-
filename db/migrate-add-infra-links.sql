-- Adds the infra_links table: curated terminal↔pipeline↔refinery linkages for
-- the oil facilities in oil_infra. Powers the /api/infra/:id/chain endpoint and
-- the supply-chain section of the Infra/Vessel panels (a tanker's decoded
-- destination LOCODE → terminal → pipeline → refineries). Each link is curated
-- and cited (source_urls), never geometry-guessed. Data:
-- data/infra-links.json (research pass — see
-- docs/superpowers/specs/2026-06-11-stories-oilflow-firms-impact-design.md).
--
-- terminal_id is nullable (cross-border trunk pipelines have no single export
-- terminal). A composite PK over a nullable column would allow duplicate
-- null-terminal rows, so the PK is a synthetic id `${pipeline_id}__${terminal_id||'none'}`.
--
-- Idempotent. Run via:
--   docker compose exec -T postgres psql -U shadow -d shadow < db/migrate-add-infra-links.sql
-- The loader (load-infra-links.ts) also creates this table on first run, so a
-- separate migration step is optional.

CREATE TABLE IF NOT EXISTS infra_links (
  id            TEXT PRIMARY KEY,     -- `${pipeline_id}__${terminal_id||'none'}`
  pipeline_id   TEXT NOT NULL,        -- matches oil_infra.id
  terminal_id   TEXT,                 -- matches oil_infra.id; null for cross-border pipelines
  refinery_ids  TEXT[],               -- matches oil_infra.id[]
  commodity     TEXT,                 -- 'crude' | 'products'
  source_urls   TEXT[],
  raw           JSONB,
  first_seen    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS infra_links_terminal_idx ON infra_links (terminal_id);
CREATE INDEX IF NOT EXISTS infra_links_pipeline_idx ON infra_links (pipeline_id);

-- depot_ids: storage/transshipment depots that sit on the pipeline between the
-- refineries and the export terminal (matches oil_infra.id[]). Added after the
-- initial table; idempotent so existing databases pick it up on re-run.
ALTER TABLE infra_links ADD COLUMN IF NOT EXISTS depot_ids TEXT[];
