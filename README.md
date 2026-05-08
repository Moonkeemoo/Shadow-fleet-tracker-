<img width="2549" height="1197" alt="Screenshot 2026-05-08 at 10 11 00" src="https://github.com/user-attachments/assets/e845451a-e613-4fa3-8ef3-38dc472369c2" />

# Shadow Fleet Tracker

A read-only OSINT aggregator focused on Russia-related shadow-fleet maritime activity.
Live AIS feed × public sanctions lists × ownership graph × news → transparent risk score
per vessel, STS rendezvous detection, port-call inference, and CSV / JSON exports for
journalism and compliance research.

> **What this is.** A research / journalism aid built on free public data sources only.
> Reproducible methodology, all factors explainable.
> **What this is not.** Legal evidence, regulatory enforcement, or a substitute for due
> diligence by a regulated party. See [`/methodology.html`](web/methodology.html) for
> full caveats.

---

## Features

- **Live map** of sanctioned tankers (Leaflet) — risk-coded markers, suspect-zone overlay,
  STS event markers, click-to-detail side panel.
- **Vessel detail** — risk score with factor breakdown, sanctions sources/programmes,
  cargo type + load status (loaded / partial / ballast) inferred from draught,
  decoded UN/LOCODE destination, FtM ownership graph (vis-network), 24h track + AIS
  dark periods with Sentinel-1 SAR verification deep-links, aliases / previous names,
  GDELT news mentions, Wikipedia / Wikidata lookup, 14 external reference deep-links.
- **STS event detection** — proximity + slow-speed + dwell-time clustering of tanker pairs.
- **Activity timeline** — auto-bucketed SVG strip below map showing sanctioned vs all-tankers
  over time; configurable range (1h–all).
- **Daily digest page** — top high-risk visible, newly listed last 180d, STS events,
  dark-in-zones, new vessels first-seen today.
- **Researcher endpoints** — bulk feeds with `?format=csv`:
  `/api/sanctioned-active`, `/api/sts-events`, `/api/newly-listed`, `/api/newly-active`,
  `/api/advanced-filter`, `/api/fleet-stats`, `/api/owner-fleet-activity/:id`,
  `POST /api/batch-screen` for bulk IMO compliance screening.
- **Reverse-graph search** — `Sovcomflot` / `NITC` / etc. → list of vessels they own
  with live AIS positions where available.

See [`/methodology.html`](web/methodology.html) for the full algorithm + data-source
documentation.

---

## Architecture

```
External:
  AISStream WS  ·  Treasury OFAC SDN  ·  OpenSanctions Maritime + FtM
  GDELT 2.0     ·  Wikidata SPARQL    ·  Sentinel-1 SAR (deep-links only)

Local services:
  ingestor (Bun)  →  Postgres 16 + TimescaleDB
  api      (Bun) ──────────────┘
                     ↓
  Static UI (Leaflet + vis-network)
```

- **AIS firehose** ingested via [AISStream.io](https://aisstream.io) WebSocket.
  Filtered to commercial fleet (AIS ship_type 60–89) at write time. Batched inserts
  (1 s flush / 500 rows) so the DB keeps up at global volume.
- **Sanctions lists** loaded one-shot from CSV / JSON via `bun run load-*` scripts.
- **Risk scoring**, STS clustering, port-call inference, and ownership graph are pure
  logic on top of the above tables.

Detailed methodology: [`web/methodology.html`](web/methodology.html).

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- [Docker](https://www.docker.com/) + Docker Compose
- An AISStream.io API key (free, register at https://aisstream.io)
- ~10 GB free disk for the first 30 days of position history (compresses ~10× after 7 d)

---

## Quick start

```bash
# 1. Clone + install
git clone https://github.com/Moonkeemoo/shipship.git
cd shipship
bun install

# 2. Configure
cp .env.example .env
# Edit .env: set AISSTREAM_KEY=<your key>
# Default DATABASE_URL points at the docker-compose Postgres on port 5433

# 3. Spin up Postgres + TimescaleDB
bun run db:up
# Wait ~5 s for it to come up, then:
docker exec shadow-postgres pg_isready -U shadow -d shadow   # → "accepting connections"

# 4. Apply additional migrations (entities table for ownership graph, compression policy)
docker exec -i shadow-postgres psql -U shadow -d shadow < db/migrate-add-entities.sql
docker exec -i shadow-postgres psql -U shadow -d shadow < db/migrate-compression-retention.sql

# 5. Load sanctions data (one-time; rerun weekly)
bun run load-sanctions          # OFAC SDN — 1,481 vessels
bun run load-opensanctions      # OpenSanctions Maritime aggregate — 13,857 vessels
bun run load-ownership          # OpenSanctions FtM graph — 248k entities, 11k relations
                                # (~321 MB download, ~20 s ingest)

# 6. Smoke-test the AIS connection (no DB writes)
bun run smoke

# 7. Start the ingestor (writes positions to DB, run continuously)
bun run ingest

# 8. In another terminal, start the API + UI server
bun run serve

# 9. Open the dashboard
open http://localhost:3000
```

Within a few minutes you should see vessels appearing on the map. Sanctioned
tanker matches accumulate over time as vessels broadcast their static data.

---

## Operational commands

| Command | Purpose |
|---|---|
| `bun run smoke` | Connect to AISStream, log samples, no DB writes |
| `bun run ingest` | Production ingestor, writes positions to DB |
| `bun run serve` | API server + static UI on `:3000` |
| `bun run load-sanctions` | (Re-)load OFAC SDN |
| `bun run load-opensanctions` | (Re-)load OpenSanctions Maritime |
| `bun run load-ownership` | (Re-)load OpenSanctions FtM graph |
| `bun run db:up` / `bun run db:down` | Postgres container lifecycle |
| `bun run db:psql` | Open a `psql` shell into the DB |
| `bun run db:logs` | Tail Postgres container logs |

---

## Configuration

`.env` keys:

| Key | Default | Notes |
|---|---|---|
| `AISSTREAM_KEY` | required | Get one at https://aisstream.io |
| `DATABASE_URL` | `postgresql://shadow:shadow_dev@localhost:5433/shadow` | Matches `docker-compose.yml` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `AIS_BBOXES` | `[[[-90,-180],[90,180]]]` | JSON array of `[[SW_lat, SW_lon], [NE_lat, NE_lon]]` boxes. Default = global. |

To track only a region, replace `AIS_BBOXES` with one or more bboxes. Example
(Baltic + Black Sea + Persian Gulf + Singapore Strait):

```
AIS_BBOXES=[[[53,-10],[66,31]],[[30,20],[48,42]],[[20,48],[30,60]],[[-2,98],[8,108]]]
```

---

## Data sources

All free, license-compatible with non-commercial / journalistic use:

| Source | What | License |
|---|---|---|
| [AISStream.io](https://aisstream.io) | Real-time AIS WebSocket | Free with API key |
| [OFAC SDN](https://www.treasury.gov/ofac/downloads/sdn.csv) | U.S. sanctioned vessels | Public domain (USG) |
| [OpenSanctions Maritime](https://www.opensanctions.org/datasets/maritime/) | Aggregated sanctions + detentions (50+ source lists) | [CC-BY-NC-4.0 + commercial tier](https://www.opensanctions.org/licensing/) |
| [OpenSanctions FtM](https://www.opensanctions.org/datasets/sanctions/) | Follow-the-Money entity graph | Same |
| [GDELT 2.0 Doc API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) | News article search | Free |
| [Wikidata SPARQL](https://query.wikidata.org/) | Per-IMO entity / Wikipedia / image | CC0 |
| [Copernicus Browser](https://browser.dataspace.copernicus.eu/) | Sentinel-1 SAR (deep-link only, no fetch) | ESA terms |

### Data we deliberately do NOT use

- Equasis (TOS forbids automated scraping)
- Lloyd's List Intelligence / MarineTraffic Premium / Windward / Kpler (commercial)
- Anything paid

---

## Stack

- **Runtime**: [Bun](https://bun.sh) (TypeScript strict, `noUncheckedIndexedAccess`)
- **DB**: PostgreSQL 16 + [TimescaleDB](https://www.timescale.com/) (positions hypertable
  with 6 h chunks, 7 d compression, 90 d retention)
- **Driver**: [`postgres`](https://github.com/porsager/postgres) (postgres-js)
- **Server**: native `Bun.serve` (no framework)
- **UI**: vanilla HTML + [Leaflet](https://leafletjs.com/) + [vis-network](https://visjs.org/)

No build step. No bundler. No SPA framework.

---

## Repo layout

```
db/                     SQL migrations
docs/                   research artifacts + archived plan docs
packages/api/
  package.json
  src/
    cli/                bun run entrypoints (smoke, ingest, load-*)
    env.ts log.ts db.ts types.ts          base infrastructure
    ingestor.ts                            AIS WebSocket subscriber
    server.ts                              HTTP API + static serve
    risk.ts zones.ts ports.ts              domain logic
web/
  index.html            live-map dashboard
  digest.html           daily aggregate page
  methodology.html      sources + scoring + limitations (full docs)
docker-compose.yml      Postgres + TimescaleDB
```

---

## Status

This is a research project, not a hosted service. There is no public deploy.
If you spin it up, you run it locally / on your own infra. The methodology
page is the canonical reference for what every number means and where every
piece of data comes from.

Issues / corrections welcome via the repo.

---

## License

Code: MIT (forthcoming).
Data: respect upstream terms, see Data sources table above.
