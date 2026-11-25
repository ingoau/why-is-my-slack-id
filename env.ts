import { createEnv } from "@t3-oss/env-core";
import * as z from "zod";

export const env = createEnv({
  server: {
    SLACK_BOT_TOKEN: z.string().min(1),
    SLACK_APP_TOKEN: z.string().min(1),
    CHANNEL_ID: z.string().min(1),
    OPENROUTER_KEY: z.string().min(1),
    CURSOR_API_KEY: z.string().min(1),
    SLACK_USER_TOKEN: z.string().min(1),
    // Set to "true" to skip the once-per-day-per-user limit and allow a user
    // to run several analyses at once.
    DISABLE_RATE_LIMIT: z.stringbool().default(false),
    // Analyses allowed to run at once across all users; the rest are queued.
    MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(3),
    // Where pending requests are saved so they survive a restart.
    STATE_DIR: z.string().default("data"),
  },

  /**
   * What object holds the environment variables at runtime. This is usually
   * `process.env` or `import.meta.env`.
   */
  runtimeEnv: process.env,

  /**
   * By default, this library will feed the environment variables directly to
   * the Zod validator.
   *
   * This means that if you have an empty string for a value that is supposed
   * to be a number (e.g. `PORT=` in a ".env" file), Zod will incorrectly flag
   * it as a type mismatch violation. Additionally, if you have an empty string
   * for a value that is supposed to be a string with a default value (e.g.
   * `DOMAIN=` in an ".env" file), the default value will never be applied.
   *
   * In order to solve these issues, we recommend that all new projects
   * explicitly specify this option as true.
   */
  emptyStringAsUndefined: true,
});
