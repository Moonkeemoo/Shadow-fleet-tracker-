import postgres from "postgres";
import { env } from "./env.ts";

export const sql = env.DATABASE_URL
  ? postgres(env.DATABASE_URL, {
      // Postgres-js: pass timestamps as strings to avoid Date instance issues
      transform: { undefined: null },
      max: 10,
      idle_timeout: 30,
      // Safety net: cap every statement at 30 s server-side. A pathological
      // query (e.g. an STS self-join on a huge vessel set) then self-aborts
      // instead of pinning a CPU core and exhausting the connection pool.
      connection: { statement_timeout: 30000 },
    })
  : null;

export type Sql = NonNullable<typeof sql>;
