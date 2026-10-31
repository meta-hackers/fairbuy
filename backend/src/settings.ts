import { z } from 'zod';
const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  FAIRBUY_MODE: z.enum(['live', 'demo']).default('live'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().default(''),
  MODEL_API_KEY: z.string().default(''),
  ASK_MODEL: z.string().default('muse-spark-1.3-contributor'),
  CONFIGURE_MODEL: z.string().default('muse-spark-1.3-contributor'),
  DISCOVERY_MODEL: z.string().default('muse-spark-1.3-contributor'),
  REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('medium'),
  SEARCH_PROVIDER: z.enum(['meta', 'brave']).default('meta'),
  BRAVE_API_KEY: z.string().default(''),
  APP_ACCESS_TOKEN: z.string().default(''),
  APP_ORIGIN: z.string().default(''),
  RENDER_EXTERNAL_URL: z.string().default(''),
});
export type Settings = z.infer<typeof Schema>;
export function settings(env = process.env): Settings {
  const value = Schema.parse(env);
  if (value.NODE_ENV === 'production' && !value.DATABASE_URL) throw new Error('DATABASE_URL is required in production');
  return value;
}
