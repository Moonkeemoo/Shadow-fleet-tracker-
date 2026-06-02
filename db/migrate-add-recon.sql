-- Adds recon data sources: Port State Control detentions + documented investigative cases.
-- Powers the recon risk factors `psc_detained_recently` and `in_known_case`,
-- and the "Port State Control" / "Documented cases" panels in the UI.
--
-- Idempotent. Run via:
--   docker compose exec -T postgres psql -U shadow -d shadow -f /tmp/migrate-add-recon.sql
-- The loaders (load-psc.ts / load-cases.ts) also create these tables on first run,
-- so a separate migration step is optional.

-- Port State Control detentions (Paris MoU, Tokyo MoU, USCG, ...).
-- Substandard vessels detained by flag/port authorities — a strong, independent
-- shadow-fleet signal (the dark fleet skews to under-maintained tonnage).
CREATE TABLE IF NOT EXISTS psc_detentions (
  id             TEXT PRIMARY KEY,       -- stable: authority|imo|detained_on
  imo            BIGINT,
  vessel_name    TEXT,
  flag           TEXT,
  authority      TEXT NOT NULL,          -- 'Paris MoU' | 'Tokyo MoU' | 'USCG' | ...
  port           TEXT,
  detained_on    DATE,
  released_on    DATE,
  deficiencies   INTEGER,
  detention_days INTEGER,
  source_url     TEXT,
  raw            JSONB,
  first_seen     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS psc_imo_idx         ON psc_detentions (imo) WHERE imo IS NOT NULL;
CREATE INDEX IF NOT EXISTS psc_detained_on_idx ON psc_detentions (detained_on DESC);

-- Documented investigative cases (KSE Institute, CREA, UANI, OCCRP, press).
-- Each case names one or more vessels (by IMO) and links the public source.
-- Doubles as a ground-truth set for calibrating the risk weights.
CREATE TABLE IF NOT EXISTS known_cases (
  id            TEXT PRIMARY KEY,        -- stable slug
  title         TEXT NOT NULL,
  summary       TEXT,
  source        TEXT,                    -- 'KSE' | 'CREA' | 'UANI' | 'OCCRP' | ...
  source_url    TEXT,
  published_on  DATE,
  tags          TEXT[],
  imos          BIGINT[],                -- vessels named in the case
  first_seen    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cases_imos_idx   ON known_cases USING GIN (imos);
CREATE INDEX IF NOT EXISTS cases_source_idx ON known_cases (source);
