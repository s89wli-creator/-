import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  API_PORT: z.coerce.number().int().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SESSION_IDLE_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Rakan <no-reply@rakan.local>'),
  MAIL_TRANSPORT: z.enum(['smtp', 'log', 'memory']).optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** 32 random bytes, base64. Master key for field encryption (per-tenant keys are derived from it). */
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded')
    .optional(),
  IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(50_000).default(5000),
  /** AI provider. Defaults to "anthropic" when ANTHROPIC_API_KEY is set, otherwise AI features are off ("none"). */
  AI_PROVIDER: z.enum(['anthropic', 'fake', 'none']).optional(),
  /** Server-side only. Never sent to the browser. */
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  /** Encrypted file storage (visit recordings). Local disk for now; an in-Kingdom object store adapter later. */
  STORAGE_DIR: z.string().default('./var/storage'),
  /** Platform console requires two-step verification (always on in production). */
  PLATFORM_ADMIN_REQUIRE_MFA: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

/** Development/test-only key so local setups work out of the box. Never accepted in production. */
export const DEV_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

export type AppConfig = z.infer<typeof envSchema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    if (!parsed.data.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    // The log/memory transports would expose password-reset and invitation links in logs.
    if (!parsed.data.SMTP_URL || (parsed.data.MAIL_TRANSPORT && parsed.data.MAIL_TRANSPORT !== 'smtp')) {
      throw new Error('Production requires SMTP_URL and MAIL_TRANSPORT=smtp');
    }
    if (!parsed.data.DATA_ENCRYPTION_KEY || parsed.data.DATA_ENCRYPTION_KEY === DEV_ENCRYPTION_KEY) {
      throw new Error('Production requires a unique DATA_ENCRYPTION_KEY');
    }
    parsed.data.PLATFORM_ADMIN_REQUIRE_MFA = true;
    if (parsed.data.AI_PROVIDER === 'fake') throw new Error('AI_PROVIDER=fake is for tests only');
  }
  return parsed.data;
}
