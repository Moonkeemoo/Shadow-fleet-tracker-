import { z } from "zod";

const schema = z.object({
  AISSTREAM_KEY: z.string().min(10, "AISSTREAM_KEY missing or too short"),
  DATABASE_URL: z.string().optional(),
  // ACLED API credentials (load-acled-strikes.ts) — optional, the loader
  // degrades gracefully (logs acled_not_configured, exit 0) when absent.
  ACLED_EMAIL: z.string().optional(),
  ACLED_PASSWORD: z.string().optional(),
  // NASA FIRMS map key (free at https://firms.modaps.eosdis.nasa.gov/api/) —
  // used by the /api/fires endpoint. Optional: without it the endpoint
  // returns available:false instead of calling NASA.
  FIRMS_MAP_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  AIS_BBOXES: z
    .string()
    .default("[[[53,-10],[66,31]]]")
    .transform((s, ctx) => {
      try {
        const parsed = JSON.parse(s) as unknown;
        if (!Array.isArray(parsed)) throw new Error("not array");
        return parsed as number[][][];
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `AIS_BBOXES must be valid JSON array: ${String(err)}`,
        });
        return z.NEVER;
      }
    }),
});

export const env = schema.parse(process.env);
