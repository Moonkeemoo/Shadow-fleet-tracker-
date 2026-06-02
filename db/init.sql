-- Run on first init by docker-entrypoint-initdb.d.
-- Idempotent.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Vessel master record. One row per MMSI.
CREATE TABLE IF NOT EXISTS vessels (
  mmsi          BIGINT PRIMARY KEY,
  imo           BIGINT,
  name          TEXT,
  call_sign     TEXT,
  ship_type     INTEGER,
  destination   TEXT,
  draught       REAL,
  dim_a         INTEGER,
  dim_b         INTEGER,
  dim_c         INTEGER,
  dim_d         INTEGER,
  first_seen    TIMESTAMPTZ DEFAULT NOW(),
  last_seen     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS vessels_imo_idx        ON vessels (imo) WHERE imo IS NOT NULL;
CREATE INDEX IF NOT EXISTS vessels_ship_type_idx  ON vessels (ship_type);

-- Time-series vessel positions. Hypertable for TimescaleDB.
CREATE TABLE IF NOT EXISTS positions (
  ts            TIMESTAMPTZ NOT NULL,
  mmsi          BIGINT NOT NULL,
  lat           REAL NOT NULL,
  lon           REAL NOT NULL,
  sog           REAL,
  cog           REAL,
  heading       REAL,
  nav_status    INTEGER
);
SELECT create_hypertable('positions', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '1 day');
CREATE INDEX IF NOT EXISTS positions_mmsi_ts_idx ON positions (mmsi, ts DESC);

-- Sanctioned vessels (loaded from OFAC SDN, EU, OFSI lists).
CREATE TABLE IF NOT EXISTS sanctioned_vessels (
  source        TEXT NOT NULL,        -- 'OFAC' | 'EU' | 'OFSI'
  identifier    TEXT NOT NULL,        -- IMO if available, else hash(name+flag)
  imo           BIGINT,
  mmsi          BIGINT,
  name          TEXT,
  listed_at     TIMESTAMPTZ,
  delisted_at   TIMESTAMPTZ,
  reason        TEXT,
  raw           JSONB,
  PRIMARY KEY (source, identifier)
);
CREATE INDEX IF NOT EXISTS sanctioned_imo_idx  ON sanctioned_vessels (imo)  WHERE imo  IS NOT NULL;
CREATE INDEX IF NOT EXISTS sanctioned_mmsi_idx ON sanctioned_vessels (mmsi) WHERE mmsi IS NOT NULL;

-- Port State Control detentions (Paris/Tokyo MoU, ...). See db/migrate-add-recon.sql.
CREATE TABLE IF NOT EXISTS psc_detentions (
  id             TEXT PRIMARY KEY,
  imo            BIGINT,
  vessel_name    TEXT,
  flag           TEXT,
  authority      TEXT NOT NULL,
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

-- Documented investigative cases (KSE / CREA / UANI / OCCRP). See db/migrate-add-recon.sql.
CREATE TABLE IF NOT EXISTS known_cases (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  summary       TEXT,
  source        TEXT,
  source_url    TEXT,
  published_on  DATE,
  tags          TEXT[],
  imos          BIGINT[],
  first_seen    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cases_imos_idx   ON known_cases USING GIN (imos);
CREATE INDEX IF NOT EXISTS cases_source_idx ON known_cases (source);
