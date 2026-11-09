import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, client, outbox, ownerQuery, registerCompany, resetDb, startApp } from './helpers';

let app: INestApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  outbox(app).length = 0;
});

describe('registration and session', () => {
  it('registers a company owner and returns their profile', async () => {
    const { me, client: c } = await registerCompany(app, { email: 'Owner@Acme.SA', company: 'شركة أكمي' });
    expect(me.user.email).toBe('owner@acme.sa');
    expect(me.activeTenant.name).toBe('شركة أكمي');
    expect(me.activeTenant.role).toBe('owner');
    expect(me.activeTenant.permissions).toContain('billing.manage');

    const [user] = await ownerQuery<{ password_hash: string }>('SELECT password_hash FROM users');
    expect(user!.password_hash).toMatch(/^\$argon2id\$/);
    const logs = await ownerQuery<{ action: string }>('SELECT action FROM audit_logs');
    expect(logs.map((l) => l.action)).toContain('tenant.create');

    await c.post('/auth/logout').expect(204);
    await c.get('/auth/me').expect(401);
  });

  it('sets a hardened HttpOnly session cookie', async () => {
    const c = await client(app);
    const res = await c
      .post('/auth/register', { fullName: 'Sara', email: 's@a.sa', password: PASSWORD, companyName: 'Acme' })
      .expect(201);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((h) => h.startsWith('rakan_session='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it('rejects duplicate email and invalid input', async () => {
    await registerCompany(app, { email: 'dup@a.sa', company: 'Alpha' });
    const c = await client(app);
    const dup = await c.post('/auth/register', { fullName: 'X Y', email: 'DUP@a.sa', password: PASSWORD, companyName: 'Beta' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    const bad = await c.post('/auth/register', { fullName: 'X', email: 'nope', password: 'short', companyName: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires a session for protected routes', async () => {
    const c = await client(app);
    const res = await c.get('/team/members');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects state-changing requests without a valid CSRF token', async () => {
    const c = await client(app);
    const res = await c.agent
      .post('/api/auth/login')
      .set('x-csrf-token', 'forged')
      .send({ email: 'a@a.sa', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects expired sessions', async () => {
    const { client: c } = await registerCompany(app, { email: 'exp@a.sa', company: 'Alpha' });
    await ownerQuery(`UPDATE sessions SET idle_expires_at = now() - interval '1 minute'`);
    await c.get('/auth/me').expect(401);
  });
});

describe('login and lockout', () => {
  it('logs in with correct credentials, generic error otherwise', async () => {
    await registerCompany(app, { email: 'log@a.sa', company: 'Alpha' });
    const c = await client(app);
    const wrong = await c.post('/auth/login', { email: 'log@a.sa', password: 'wrong-password-123' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await c.post('/auth/login', { email: 'nobody@a.sa', password: 'wrong-password-123' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toEqual(wrong.body.error);
    await c.post('/auth/login', { email: 'LOG@a.sa', password: PASSWORD }).expect(200);
    const me = (await c.get('/auth/me').expect(200)).body;
    expect(me.activeTenant.name).toBe('Alpha');
  });

  it('locks the account after 5 failed attempts, even for the right password', async () => {
    await registerCompany(app, { email: 'lock@a.sa', company: 'Alpha' });
    const c = await client(app);
    for (let i = 0; i < 5; i++) await c.post('/auth/login', { email: 'lock@a.sa', password: 'bad-password-' + i }).expect(401);
    const locked = await c.post('/auth/login', { email: 'lock@a.sa', password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    const logs = await ownerQuery<{ action: string }>(`SELECT action FROM audit_logs WHERE action LIKE 'auth.%'`);
    expect(logs.map((l) => l.action)).toContain('auth.account_locked');
  });

  it('rate limits the login endpoint', async () => {
    const limited = await startApp({ AUTH_RATE_LIMIT_PER_MINUTE: '10' });
    try {
      const c = await client(limited);
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await c.post('/auth/login', { email: `r${i}@a.sa`, password: 'x' })).status);
      expect(statuses).toContain(429);
    } finally {
      await limited.close();
    }
  });
});

describe('password reset', () => {
  it('resets via emailed single-use token and revokes existing sessions', async () => {
    const { client: owner } = await registerCompany(app, { email: 'reset@a.sa', company: 'Alpha' });
    const anon = await client(app);
    await anon.post('/auth/password/forgot', { email: 'reset@a.sa' }).expect(202);
    // Unknown email: same response, no email sent.
    await anon.post('/auth/password/forgot', { email: 'ghost@a.sa' }).expect(202);
    const mails = outbox(app);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('إعادة تعيين');
    const token = decodeURIComponent(mails[0]!.text.match(/token=([^\s]+)/)![1]!);

    await anon.post('/auth/password/reset', { token, password: 'a-brand-new-password' }).expect(200);
    const reuse = await anon.post('/auth/password/reset', { token, password: 'another-new-password' });
    expect(reuse.body.error.code).toBe('INVALID_TOKEN');

    await owner.get('/auth/me').expect(401); // old session revoked
    await anon.post('/auth/login', { email: 'reset@a.sa', password: PASSWORD }).expect(401);
    await anon.post('/auth/login', { email: 'reset@a.sa', password: 'a-brand-new-password' }).expect(200);
  });

  it('rejects expired reset tokens', async () => {
    await registerCompany(app, { email: 'old@a.sa', company: 'Alpha' });
    const anon = await client(app);
    await anon.post('/auth/password/forgot', { email: 'old@a.sa' }).expect(202);
    const token = decodeURIComponent(outbox(app)[0]!.text.match(/token=([^\s]+)/)![1]!);
    await ownerQuery(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'`);
    const res = await anon.post('/auth/password/reset', { token, password: 'a-brand-new-password' });
    expect(res.status).toBe(400);
  });
});
