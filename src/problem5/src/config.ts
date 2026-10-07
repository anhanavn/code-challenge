import { z } from 'zod';

/** Treat empty strings (e.g. `API_KEY=` in .env) as "not set". */
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_URL: z.string().url().default('postgres://tasks:tasks@localhost:5432/tasks'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_KEY: optionalString.pipe(z.string().min(16, 'API_KEY must be at least 16 characters').optional()),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  /** Number of reverse proxies in front of the app; needed for correct client IPs in rate limiting. */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return result.data;
}
