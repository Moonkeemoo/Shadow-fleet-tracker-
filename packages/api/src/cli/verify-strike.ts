// Curation CLI for auto-fed strike candidates (origin 'acled', 'gdelt' or
// 'firms-trigger' rows in infra_strikes, inserted unverified by
// load-acled-strikes.ts / load-gdelt-strikes.ts / load-firms-triggered.ts).
// Spec: docs/superpowers/specs/2026-06-11-acled-strikes-feed-design.md
//
// Run:
//   bun run verify-strike acled-RUS12345                       # promote: verified=TRUE
//   bun run verify-strike --reject gdelt-ryazan-refinery-20260611   # delete the candidate
import { sql } from "../db.ts";
import { logger } from "../log.ts";

function usage(): void {
  console.error("Usage: bun run verify-strike <id>            promote an ACLED/GDELT/FIRMS-trigger candidate (verified=TRUE)");
  console.error("       bun run verify-strike --reject <id>   delete an ACLED/GDELT/FIRMS-trigger candidate");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reject = args[0] === "--reject";
  const id = reject ? args[1] : args[0];
  if (!id) {
    usage();
    process.exit(1);
  }

  if (!sql) {
    logger.error({ event: "no_db" }, "DATABASE_URL not set");
    process.exit(1);
  }

  // Guard on origin so curated rows can never be touched by this CLI.
  const origins = ["acled", "gdelt", "firms-trigger"];
  if (reject) {
    const res = await sql`DELETE FROM infra_strikes WHERE id = ${id} AND origin = ANY(${origins})`;
    logger.info({ event: "strike_rejected", id, affected: res.count }, "auto-feed candidate deleted");
  } else {
    const res = await sql`UPDATE infra_strikes SET verified = TRUE WHERE id = ${id} AND origin = ANY(${origins})`;
    logger.info({ event: "strike_verified", id, affected: res.count }, "auto-feed candidate verified");
  }
  await sql.end({ timeout: 5 });
}

void main();
