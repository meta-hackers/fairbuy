import { z } from 'zod';
import { createHash, scryptSync } from 'node:crypto';
const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);
const AdminUsernameSchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_.-]+$/);
const AdminSchema = z.union([
  z.object({ username: AdminUsernameSchema, passwordHash: z.string().regex(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/) }).strict(),
  z.object({ username: AdminUsernameSchema, password: z.string().min(1).max(500) }).strict(),
]).transform(admin => {
  if ('passwordHash' in admin) return admin;
  // Normalize plaintext environment configuration immediately. A stable, per-user
  // salt preserves login sessions across restarts; plaintext never enters Settings.
  const salt = createHash('sha256').update(`fairbuy-admin:${admin.username.toLowerCase()}`).digest('hex').slice(0, 32);
  return { username: admin.username, passwordHash: `scrypt:${salt}:${scryptSync(admin.password, salt, 64).toString('hex')}` };
});
const AdminsSchema = z.array(AdminSchema).max(100).refine(admins => new Set(admins.map(a => a.username.toLowerCase())).size === admins.length, 'Admin usernames must be unique');
const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  FAIRBUY_MODE: z.enum(['live', 'demo']).default('live'),
  // Render supplies PORT (normally 10000); match its documented local fallback.
  PORT: z.preprocess(value => value || 4000, z.coerce.number().int().min(1).max(65535)),
  DATABASE_URL: z.string().default(''),
  MODEL_API_KEY: z.string().default(''),
  ASK_MODEL: z.string().default('muse-spark-1.3-contributor'),
  CONFIGURE_MODEL: z.string().default('muse-spark-1.3-contributor'),
  DISCOVERY_MODEL: z.string().default('muse-spark-1.3-contributor'),
  ASK_REASONING_EFFORT: ReasoningEffortSchema.default('low'),
  CONFIGURE_REASONING_EFFORT: ReasoningEffortSchema.default('low'),
  DISCOVERY_REASONING_EFFORT: ReasoningEffortSchema.default('xhigh'),
  SEARCH_PROVIDER: z.enum(['meta', 'brave']).default('brave'),
  BRAVE_API_KEY: z.string().default(''),
  INSTANT_CLASSIFIER_PROVIDER: z.enum(['disabled', 'cloudflare']).default('disabled'),
  INSTANT_CLASSIFIER_MODEL: z.enum(['@cf/meta/llama-3.1-8b-instruct-fp8-fast', '@cf/meta/llama-3.2-3b-instruct']).default('@cf/meta/llama-3.1-8b-instruct-fp8-fast'),
  CLOUDFLARE_ACCOUNT_ID: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{32}$/i)]).default(''),
  CLOUDFLARE_API_TOKEN: z.string().default(''),
  APP_ACCESS_TOKEN: z.string().default(''),
  BACKOFFICE_ADMINS: z.string().default('[]').transform(value => AdminsSchema.parse(JSON.parse(value))),
  AI_PRICE_TABLE: z.string().default('{"*":{"input":1,"output":3}}').transform(value => z.record(z.string(), z.object({ input: z.number().nonnegative().finite(), output: z.number().nonnegative().finite() })).parse(JSON.parse(value))),
  APP_ORIGIN: z.string().default(''),
  RENDER_EXTERNAL_URL: z.string().default(''),
});
export type Settings = z.infer<typeof Schema>;
export function settings(env = process.env): Settings {
  const value = Schema.parse(env);
  if (value.NODE_ENV === 'production' && !value.DATABASE_URL) throw new Error('DATABASE_URL is required in production');
  return value;
}
