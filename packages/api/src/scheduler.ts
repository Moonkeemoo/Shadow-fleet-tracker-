// Auto-feed scheduler engine for OilFront.
// Runs four jobs as isolated child processes on staggered intervals:
//   - RSS (load-rss-strikes)          every RSS_INTERVAL_MS     (default 20 min)
//   - FIRMS-triggered (load-firms-triggered) every FIRMS_INTERVAL_MS (default 60 min)
//   - GDELT (load-gdelt-strikes)      every GDELT_INTERVAL_MS   (default 180 min)
//   - rescore (cli/rescore)           every RESCORE_INTERVAL_MS (default 15 min)
//
// Both FIRMS-trigger and GDELT hit the GDELT API, so they share a mutex:
// only one of the two runs at a time. RSS hits public RSS feeds only — it
// can overlap freely. rescore is a pure DB step (clusters + scores existing
// strikes); it touches no external API and needs no mutex, so it can overlap
// any feed freely and just re-scores whatever the feeds have written so far.
//
// Each job runs as a Bun child process (Bun.spawn). Because the loaders/rescore
// call sql.end() and process.exit() internally, spawning them in isolation
// is the only safe way to avoid killing the scheduler process.

import { logger } from "./log.ts";

// ---------------------------------------------------------------------------
// Intervals (ms). Override via env vars for testing.
// ---------------------------------------------------------------------------

const RSS_INTERVAL_MS     = Number(process.env.SCHEDULER_RSS_INTERVAL_MS     ?? 20 * 60 * 1000);   // 20 min
const FIRMS_INTERVAL_MS   = Number(process.env.SCHEDULER_FIRMS_INTERVAL_MS   ?? 60 * 60 * 1000);   // 60 min
const GDELT_INTERVAL_MS   = Number(process.env.SCHEDULER_GDELT_INTERVAL_MS   ?? 180 * 60 * 1000);  // 3 h
const RESCORE_INTERVAL_MS = Number(process.env.SCHEDULER_RESCORE_INTERVAL_MS ?? 15 * 60 * 1000);   // 15 min

// Stagger: delay GDELT's first run so it doesn't collide with FIRMS-trigger at boot.
// FIRMS-trigger first fires at boot+5 s (enough for the process to settle).
// GDELT first fires at boot+3 min (well after FIRMS-trigger could have started).
// rescore first fires at boot+30 s — after the immediate RSS feed has populated,
// so the first scoring pass sees fresh candidates.
const FIRMS_BOOT_DELAY_MS = 5_000;   // 5 s after boot
const GDELT_BOOT_DELAY_MS = 3 * 60 * 1000; // 3 min after boot
const RESCORE_BOOT_DELAY_MS = 30_000; // 30 s after boot

// ---------------------------------------------------------------------------
// Script paths (absolute via import.meta.dirname so this file can live anywhere)
// ---------------------------------------------------------------------------

const DIR = new URL(".", import.meta.url).pathname
  // Bun on Windows gives a /C:/... path from URL; strip the leading slash on win32.
  .replace(/^\/([A-Za-z]:)/, "$1");

const SCRIPTS = {
  rss:     `${DIR}cli/load-rss-strikes.ts`,
  firms:   `${DIR}cli/load-firms-triggered.ts`,
  gdelt:   `${DIR}cli/load-gdelt-strikes.ts`,
  rescore: `${DIR}cli/rescore.ts`,
} as const;

type FeedName = keyof typeof SCRIPTS;

// ---------------------------------------------------------------------------
// GDELT mutex — only one GDELT-touching loader at a time
// ---------------------------------------------------------------------------

let gdeltBusy = false;

// ---------------------------------------------------------------------------
// Spawn a loader child process and wait for it to complete.
// Returns { exitCode, durationMs }. Never throws — errors are logged as warnings.
// ---------------------------------------------------------------------------

async function runLoader(
  name: FeedName,
  args: readonly string[] = [],
): Promise<{ exitCode: number; durationMs: number }> {
  const script = SCRIPTS[name];
  const startMs = Date.now();

  logger.info({ event: "feed_run_start", feed: name, script, args }, `starting ${name} loader`);

  try {
    const child = Bun.spawn(["bun", "run", script, ...args], {
      stdout: "inherit",
      stderr: "inherit",
      env: process.env as Record<string, string>,
    });

    const exitCode = await child.exited;
    const durationMs = Date.now() - startMs;

    if (exitCode === 0) {
      logger.info(
        { event: "feed_run_done", feed: name, exitCode, durationMs },
        `${name} loader finished OK (${durationMs}ms)`,
      );
    } else {
      logger.warn(
        { event: "feed_run_done", feed: name, exitCode, durationMs },
        `${name} loader exited non-zero (code=${exitCode}, ${durationMs}ms)`,
      );
    }

    return { exitCode, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    logger.warn(
      { event: "feed_run_error", feed: name, err: String(err), durationMs },
      `${name} loader threw during spawn`,
    );
    return { exitCode: -1, durationMs };
  }
}

// ---------------------------------------------------------------------------
// Per-feed runners — handle the GDELT mutex before calling runLoader.
// ---------------------------------------------------------------------------

async function runRss(): Promise<void> {
  // RSS is independent — no mutex needed.
  await runLoader("rss");
}

async function runFirms(): Promise<void> {
  if (gdeltBusy) {
    logger.warn(
      { event: "feed_skip_mutex", feed: "firms" },
      "FIRMS-trigger skipped: GDELT mutex is held by another loader — will retry next interval",
    );
    return;
  }
  gdeltBusy = true;
  try {
    await runLoader("firms");
  } finally {
    gdeltBusy = false;
  }
}

async function runGdelt(): Promise<void> {
  if (gdeltBusy) {
    logger.warn(
      { event: "feed_skip_mutex", feed: "gdelt" },
      "GDELT skipped: GDELT mutex is held by another loader — will retry next interval",
    );
    return;
  }
  gdeltBusy = true;
  try {
    await runLoader("gdelt");
  } finally {
    gdeltBusy = false;
  }
}

// Wide rescore window (days): the table is tiny (~275 rows), so re-scoring the
// FULL table every cycle is cheap and idempotent. A narrow window would leave
// older history unscored (NULL tier with verified=true → inconsistent if the
// table is reset). 100000 days (~274 y) covers all rows. `bun run rescore`'s
// OWN default stays 180 for ad-hoc manual use.
const RESCORE_WINDOW_DAYS = "100000";

async function runRescore(): Promise<void> {
  // Pure DB step — no GDELT API, no mutex. Safe to overlap any feed.
  await runLoader("rescore", [RESCORE_WINDOW_DAYS]);
}

// ---------------------------------------------------------------------------
// Active timer handles (kept for graceful shutdown)
// ---------------------------------------------------------------------------

const timers: ReturnType<typeof setInterval>[] = [];
const bootTimers: ReturnType<typeof setTimeout>[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SchedulerOpts {
  /** If true, FIRMS-trigger is skipped (FIRMS_MAP_KEY not set). */
  firmsEnabled: boolean;
}

export function startScheduler(opts: SchedulerOpts): void {
  const schedule: Record<string, string> = {
    rss: `every ${RSS_INTERVAL_MS / 60000} min (immediate first run)`,
    gdelt: `every ${GDELT_INTERVAL_MS / 60000} min (first run after ${GDELT_BOOT_DELAY_MS / 60000} min)`,
    rescore: `every ${RESCORE_INTERVAL_MS / 60000} min (first run after ${RESCORE_BOOT_DELAY_MS / 1000}s)`,
  };
  if (opts.firmsEnabled) {
    schedule.firms = `every ${FIRMS_INTERVAL_MS / 60000} min (first run after ${FIRMS_BOOT_DELAY_MS / 1000}s)`;
  } else {
    schedule.firms = "disabled (FIRMS_MAP_KEY not set)";
  }

  logger.info(
    { event: "scheduler_start", schedule },
    "OilFront auto-feed scheduler starting",
  );

  // ── RSS: immediate first run, then every RSS_INTERVAL_MS ──────────────────
  void runRss();
  timers.push(
    setInterval(() => {
      void runRss();
    }, RSS_INTERVAL_MS),
  );

  // ── FIRMS-trigger: first run after FIRMS_BOOT_DELAY_MS ────────────────────
  if (opts.firmsEnabled) {
    bootTimers.push(
      setTimeout(() => {
        void runFirms();
        timers.push(
          setInterval(() => {
            void runFirms();
          }, FIRMS_INTERVAL_MS),
        );
      }, FIRMS_BOOT_DELAY_MS),
    );
  }

  // ── GDELT: first run after GDELT_BOOT_DELAY_MS ────────────────────────────
  bootTimers.push(
    setTimeout(() => {
      void runGdelt();
      timers.push(
        setInterval(() => {
          void runGdelt();
        }, GDELT_INTERVAL_MS),
      );
    }, GDELT_BOOT_DELAY_MS),
  );

  // ── rescore: first run after RESCORE_BOOT_DELAY_MS (after the immediate RSS
  // feed populates), then every RESCORE_INTERVAL_MS. No mutex — pure DB step. ─
  bootTimers.push(
    setTimeout(() => {
      void runRescore();
      timers.push(
        setInterval(() => {
          void runRescore();
        }, RESCORE_INTERVAL_MS),
      );
    }, RESCORE_BOOT_DELAY_MS),
  );
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export function shutdownScheduler(): void {
  logger.info({ event: "scheduler_shutdown" }, "scheduler shutting down — clearing timers");
  for (const t of bootTimers) clearTimeout(t);
  for (const t of timers) clearInterval(t);
}

process.on("SIGINT", () => {
  shutdownScheduler();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdownScheduler();
  process.exit(0);
});
