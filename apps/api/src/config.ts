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
  /** Web Push (VAPID). Generate once: npx web-push generate-vapid-keys. Without them, push stays "not configured". */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:support@rakan.local'),
  PUSH_PROVIDER: z.enum(['vapid', 'fake']).optional(),
  /** Subscription payments (EdfaPay). API key and webhook secret stay on the server. Defaults to "edfapay" when EDFAPAY_API_KEY is set. */
  PAYMENTS_PROVIDER: z.enum(['edfapay', 'fake', 'none']).optional(),
  EDFAPAY_API_KEY: z.string().optional(),
  /** Set in the EdfaPay dashboard (Webhook Secret); every notification is signed HMAC-SHA256 with it. Required to accept notifications. */
  EDFAPAY_WEBHOOK_SECRET: z.string().optional(),
  /** sandbox = demo-api.edfapay.com (no real money), live = app-api.edfapay.com. */
  EDFAPAY_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  /** Scheduled agents: runs due jobs every minute. Defaults to on, except in tests. */
  SCHEDULER_ENABLED: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  /** Voice (spokesperson voice clone, speech in/out). Defaults to "elevenlabs" when ELEVENLABS_API_KEY is set. */
  VOICE_PROVIDER: z.enum(['elevenlabs', 'fake', 'none']).optional(),
  /** Server-side only. Never sent to the browser. */
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_TTS_MODEL: z.string().default('eleven_multilingual_v2'),
  ELEVENLABS_STT_MODEL: z.string().default('scribe_v1'),
  /** Optional server default voice (e.g. a male voice with a general Saudi accent from the voice library). */
  ELEVENLABS_DEFAULT_VOICE_ID: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  ELEVENLABS_DEFAULT_VOICE_NAME: z.string().default('راكان'),
  /** Approximate list prices used for budgeting (USD); adjust to your ElevenLabs plan. */
  VOICE_TTS_USD_PER_1K_CHARS: z.coerce.number().min(0).default(0.3),
  VOICE_STT_USD_PER_MINUTE: z.coerce.number().min(0).default(0.007),
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
    if (parsed.data.VOICE_PROVIDER === 'fake') throw new Error('VOICE_PROVIDER=fake is for tests only');
    if (parsed.data.PUSH_PROVIDER === 'fake') throw new Error('PUSH_PROVIDER=fake is for tests only');
    if (parsed.data.PAYMENTS_PROVIDER === 'fake') throw new Error('PAYMENTS_PROVIDER=fake is for tests only');
    if (parsed.data.EDFAPAY_API_KEY && parsed.data.EDFAPAY_ENV === 'sandbox') console.warn('EDFAPAY_ENV=sandbox: no real money will be collected');
    if (parsed.data.EDFAPAY_API_KEY && !parsed.data.EDFAPAY_WEBHOOK_SECRET) console.warn('EDFAPAY_WEBHOOK_SECRET is missing: payment notifications will be refused');
  }
  return parsed.data;
}
