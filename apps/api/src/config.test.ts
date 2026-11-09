import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('config', () => {
  it('applies safe defaults in development', () => {
    const c = loadConfig(base);
    expect(c.SESSION_IDLE_HOURS).toBe(12);
    expect(c.AUTH_RATE_LIMIT_PER_MINUTE).toBe(10);
  });
  it('rejects missing database url', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  it('production requires secure cookies and real SMTP', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true' })).toThrow(/SMTP/);
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true', SMTP_URL: 'smtp://x', MAIL_TRANSPORT: 'log' }),
    ).toThrow(/SMTP/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true', SMTP_URL: 'smtp://x' }).COOKIE_SECURE).toBe(true);
  });
});
