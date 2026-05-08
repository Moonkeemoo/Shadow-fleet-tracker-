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

- [Bun](https://bun.sh) ≥ 1.1 — install: `curl -fsSL https://bun.sh/install | bash`
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac / Windows) or
  [Docker Engine](https://docs.docker.com/engine/install/) (Linux) + Docker Compose
- An [AISStream.io](https://aisstream.io) API key (free; register, confirm email,
  copy the key from your dashboard)
- ~10 GB free disk for 30 days of position history at global coverage
  (compresses ~10× after 7 d, auto-drops after 90 d)

Verify your install before starting:
```bash
bun --version          # → 1.1+
docker compose version # → Docker Compose v2+
docker info            # → no errors; ensures daemon is running
```

---

## First-time setup

Walk through this exactly once. Steps 6+ become your daily workflow.

### 1 · Clone + install

```bash
git clone https://github.com/Moonkeemoo/Shadow-fleet-tracker-.git
cd Shadow-fleet-tracker-
bun install
```

### 2 · Configure environment

```bash
cp .env.example .env
```

Edit `.env`:
```
AISSTREAM_KEY=<paste your key from aisstream.io dashboard>
```

Defaults you can leave alone:
- `DATABASE_URL=postgresql://shadow:shadow_dev@localhost:5433/shadow` — matches the
  docker-compose Postgres on host port **5433** (5432 is often taken on dev machines).
- `LOG_LEVEL=info`
- `AIS_BBOXES=[[[-90,-180],[90,180]]]` — global coverage by default. Replace with
  smaller bboxes if you want regional only (see Configuration table below).

### 3 · Spin up Postgres + TimescaleDB

```bash
bun run db:up
```

Wait ~5 s for the container to boot, then verify:
```bash
docker exec shadow-postgres pg_isready -U shadow -d shadow
# → /var/run/postgresql:5432 - accepting connections
```

### 4 · Apply migrations

The base schema (`vessels`, `positions` hypertable, `sanctioned_vessels`) is created
automatically on container init from `db/init.sql`. Two more migrations need to run
manually for the ownership-graph layer and TimescaleDB compression policies:

```bash
docker exec -i shadow-postgres psql -U shadow -d shadow < db/migrate-add-entities.sql
docker exec -i shadow-postgres psql -U shadow -d shadow < db/migrate-compression-retention.sql
```

Verify TimescaleDB policies got attached:
```bash
docker exec shadow-postgres psql -U shadow -d shadow \
  -c "SELECT compression_enabled, num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name='positions';"
# → compression_enabled = t
```

### 5 · Load sanctions data

Three loaders. Run sequentially (each is idempotent — safe to re-run weekly):

```bash
bun run load-sanctions          # OFAC SDN CSV — ~1,500 vessels, ~10 s
bun run load-opensanctions      # OpenSanctions Maritime — ~14k vessels, ~30 s
bun run load-ownership          # OpenSanctions FtM JSON — 321 MB stream, ~20 s
                                # → 248k entities, 11k Ownership/Director/etc. relations
```

Total downloads ≈ 350 MB. After this you have ~9k unique sanctioned IMOs in the DB,
deduplicated across 50+ source lists, ready to match against the live AIS feed.

### 6 · Smoke-test the AIS connection

Sanity check before committing to writing positions to disk. Connects to AISStream,
logs ~30 s of live messages, no DB writes:

```bash
bun run smoke
```

Expect to see ~50–150 messages/sec on global coverage. Press **Ctrl-C** to stop.
If you see authentication errors → re-check `AISSTREAM_KEY` in `.env`.

### 7 · Start the ingestor

The ingestor is meant to run continuously. It connects to AISStream, filters to
commercial fleet (ship_type 60–89), and batch-writes positions to Postgres.

In a dedicated terminal (or `tmux` / `screen` window):
```bash
bun run ingest
```

You'll see a stats line every 30 s with throughput, vessels seen, batches flushed,
and DB error count. Healthy: `dbErrors: 0`, `parseErrors: 0`, `msgPerSec` consistent.

### 8 · Start the API + UI server

In a second terminal:
```bash
bun run serve
```

Logs `shadow-fleet server up` on port `3000`.

### 9 · Open the dashboard

```bash
open http://localhost:3000        # macOS
xdg-open http://localhost:3000    # Linux
start http://localhost:3000       # Windows
```

You should see the map within seconds. Sanctioned-tanker matches start appearing as
vessels broadcast their static data (which arrives less frequently than positions —
expect 10-20 matches in the first 5 minutes, growing to 50-100+ within an hour).

---

## Daily workflow

After first-time setup, the recurring routine is:

### Start everything
```bash
bun run db:up                    # Postgres container (idempotent — no-op if running)
bun run ingest    &              # Ingestor in background
bun run serve     &              # API + UI in background
open http://localhost:3000
```

### Stop everything
```bash
pkill -INT -f "bun run packages/api"   # graceful — flushes pending writes
bun run db:down                         # stops + removes Postgres container
                                        # (data persists in named volume)
```

### Resume next day
Same as Start everything. Position history is preserved in the docker volume.
Sanctions data is also preserved — only re-run the loaders weekly to pull updates.

### Refresh sanctions data (weekly)
```bash
bun run load-sanctions
bun run load-opensanctions
bun run load-ownership
```

These overwrite previous entries (ON CONFLICT UPDATE) so it's safe to run anytime.

---

## Troubleshooting

**`port is already allocated` when running `bun run db:up`**
> Another Postgres is already bound to host port 5433. Either stop it, or edit
> `docker-compose.yml` to map a different host port and update `DATABASE_URL` in `.env`.

**Ingestor logs `dbErrors` increasing**
> Most often `invalid input syntax for type timestamp` — means the `positions`
> hypertable hasn't been created yet, or a migration failed. Re-check step 3 + 4.

**UI shows skeletons forever / vessels not loading**
> Server-side endpoints have a 20–30 s in-memory cache, so the first request after
> a restart can take 0.3–1 s. If it stays slow > 5 s, check that the ingestor isn't
> overwhelming Postgres (look at `dbErrors` in ingest logs).

**Wikidata / GDELT show "feed unavailable" for some vessels**
> Both are best-effort external lookups. GDELT is sometimes blocked by ISP /
> firewall; Wikidata times out on unfamiliar IMOs. The vessel detail panel still
> works without them — just no news / no Wikipedia article.

**`ALTER TABLE positions` hangs during migrations**
> Stop the ingestor first. Position INSERTs hold row locks that block schema changes.
> If you've stopped the ingestor and it still hangs, force-terminate idle backends:
> ```bash
> docker exec shadow-postgres psql -U shadow -d shadow \
>   -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state='active' AND query LIKE '%positions%' AND pid != pg_backend_pid();"
> ```

**Disk filling up**
> Compression policy compresses chunks > 7 days old (~10× space saving).
> Retention policy drops chunks > 90 days. To force-compress now:
> ```bash
> docker exec shadow-postgres psql -U shadow -d shadow \
>   -c "SELECT compress_chunk(c, if_not_compressed=>true) FROM show_chunks('positions') c;"
> ```

**Want to start fresh / reset all data**
> ```bash
> bun run db:down
> docker volume rm polyscalp_shadow-postgres-data shipship_shadow-postgres-data 2>/dev/null
> bun run db:up
> # Re-apply migrations (step 4) + reload sanctions (step 5)
> ```

---

## Operational commands

| Command | Purpose |
|---|---|
| `bun run smoke` | Connect to AISStream, log samples, no DB writes |
| `bun run ingest` | Production ingestor, writes positions to DB (run continuously) |
| `bun run serve` | API server + static UI on `:3000` |
| `bun run load-sanctions` | (Re-)load OFAC SDN |
| `bun run load-opensanctions` | (Re-)load OpenSanctions Maritime |
| `bun run load-ownership` | (Re-)load OpenSanctions FtM graph |
| `bun run db:up` / `bun run db:down` | Postgres container lifecycle |
| `bun run db:psql` | Open a `psql` shell into the DB |
| `bun run db:logs` | Tail Postgres container logs |
| `bunx tsc --noEmit` | TypeScript strict check (no build, no emit) |

---

## Configuration

`.env` keys:

| Key | Default | Notes |
|---|---|---|
| `AISSTREAM_KEY` | **required** | Get one at https://aisstream.io |
| `DATABASE_URL` | `postgresql://shadow:shadow_dev@localhost:5433/shadow` | Matches `docker-compose.yml` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `AIS_BBOXES` | `[[[-90,-180],[90,180]]]` | JSON array of `[[SW_lat, SW_lon], [NE_lat, NE_lon]]` boxes. Default = global. |
| `PORT` | `3000` | API + UI server port |

To track only a region, replace `AIS_BBOXES` with one or more bboxes. Example
(Baltic + Black Sea + Persian Gulf + Singapore Strait — covers main shadow-fleet
operational areas at ~50 msg/sec instead of global ~150 msg/sec):

```
AIS_BBOXES=[[[53,-10],[66,31]],[[30,20],[48,42]],[[20,48],[30,60]],[[-2,98],[8,108]]]
```

### Local-port reference

| Port | Service |
|---|---|
| `3000` | API + UI server (`bun run serve`) |
| `5433` | Postgres + TimescaleDB (host-mapped from container's 5432) |

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
