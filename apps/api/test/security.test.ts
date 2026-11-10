import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { totp } from '../src/identity/totp';
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

async function enableMfa(c: Awaited<ReturnType<typeof client>>) {
  const setup = (await c.post('/auth/mfa/setup').expect(200)).body as { secret: string; qr: string; uri: string };
  expect(setup.qr.startsWith('data:image/png;base64,')).toBe(true);
  expect(setup.uri).toContain('otpauth://totp/');
  await c.post('/auth/mfa/enable', { code: '000000' }).expect(400);
  const { recoveryCodes } = (await c.post('/auth/mfa/enable', { code: totp(setup.secret) }).expect(200)).body as { recoveryCodes: string[] };
  expect(recoveryCodes).toHaveLength(8);
  return { secret: setup.secret, recoveryCodes };
}

describe('two-step verification', () => {
  it('requires a second step at sign-in and accepts app codes', async () => {
    const { client: owner } = await registerCompany(app, { email: 'mfa@a.sa', company: 'Alpha' });
    const { secret } = await enableMfa(owner);
    expect((await owner.get('/auth/security').expect(200)).body.mfaEnabled).toBe(true);

    // The secret is stored encrypted, never in clear.
    const [row] = await ownerQuery<{ mfa_secret_enc: string }>("SELECT mfa_secret_enc FROM users WHERE email='mfa@a.sa'");
    expect(row!.mfa_secret_enc).not.toContain(secret);

    const c = await client(app);
    const res = (await c.post('/auth/login', { email: 'mfa@a.sa', password: PASSWORD }).expect(200)).body;
    expect(res.mfaRequired).toBe(true);
    await c.get('/auth/me').expect(401); // no session before the second step

    await c.post('/auth/mfa/verify', { challenge: res.challenge, code: '123456' }).expect(400);
    await c.post('/auth/mfa/verify', { challenge: res.challenge, code: totp(secret) }).expect(200);
    expect((await c.get('/auth/me').expect(200)).body.user.mfaEnabled).toBe(true);

    // A challenge is single-use.
    await c.post('/auth/mfa/verify', { challenge: res.challenge, code: totp(secret) }).expect(401);
  });

  it('locks a challenge after 5 wrong codes', async () => {
    const { client: owner } = await registerCompany(app, { email: 'lock@a.sa', company: 'Alpha' });
    const { secret } = await enableMfa(owner);
    const c = await client(app);
    const { challenge } = (await c.post('/auth/login', { email: 'lock@a.sa', password: PASSWORD }).expect(200)).body;
    for (let i = 0; i < 5; i++) await c.post('/auth/mfa/verify', { challenge, code: '000001' }).expect(400);
    await c.post('/auth/mfa/verify', { challenge, code: totp(secret) }).expect(401);
  });

  it('recovery codes work once', async () => {
    const { client: owner } = await registerCompany(app, { email: 'rec@a.sa', company: 'Alpha' });
    const { recoveryCodes } = await enableMfa(owner);
    const signIn = async () => {
      const c = await client(app);
      const { challenge } = (await c.post('/auth/login', { email: 'rec@a.sa', password: PASSWORD }).expect(200)).body;
      return { c, challenge };
    };
    const first = await signIn();
    await first.c.post('/auth/mfa/verify', { challenge: first.challenge, code: recoveryCodes[0] }).expect(200);
    const second = await signIn();
    await second.c.post('/auth/mfa/verify', { challenge: second.challenge, code: recoveryCodes[0] }).expect(400);
    const audit = await ownerQuery("SELECT 1 FROM audit_logs WHERE action='auth.mfa_recovery_code_used'");
    expect(audit).toHaveLength(1);
  });

  it('turning MFA off needs a valid code', async () => {
    const { client: owner } = await registerCompany(app, { email: 'off@a.sa', company: 'Alpha' });
    const { secret } = await enableMfa(owner);
    await owner.post('/auth/mfa/disable', { code: '000000' }).expect(400);
    await owner.post('/auth/mfa/disable', { code: totp(secret) }).expect(204);
    const c = await client(app);
    expect((await c.post('/auth/login', { email: 'off@a.sa', password: PASSWORD }).expect(200)).body).toEqual({ ok: true });
  });
});

describe('email verification', () => {
  it('sends a link at sign-up; the link verifies once', async () => {
    const { client: owner } = await registerCompany(app, { email: 'ver@a.sa', company: 'Alpha' });
    expect((await owner.get('/auth/me').expect(200)).body.user.emailVerified).toBe(false);
    const mail = outbox(app).find((m) => m.to === 'ver@a.sa')!;
    const token = decodeURIComponent(mail.text.match(/token=([^\s]+)/)![1]!);
    const anon = await client(app);
    await anon.post('/auth/email/verify', { token }).expect(200);
    await anon.post('/auth/email/verify', { token }).expect(400);
    expect((await owner.get('/auth/me').expect(200)).body.user.emailVerified).toBe(true);

    outbox(app).length = 0;
    await owner.post('/auth/email/resend').expect(202);
    expect(outbox(app)).toHaveLength(0); // already verified: nothing sent
  });
});

describe('active sessions', () => {
  it('lists own sessions and ends only own sessions', async () => {
    const { client: a1 } = await registerCompany(app, { email: 's@a.sa', company: 'Alpha' });
    const a2 = await client(app);
    await a2.post('/auth/login', { email: 's@a.sa', password: PASSWORD }).expect(200);
    const { client: b } = await registerCompany(app, { email: 's@b.sa', company: 'Beta' });

    const list = (await a1.get('/auth/security').expect(200)).body.sessions as { id: string; current: boolean }[];
    expect(list).toHaveLength(2);
    const other = list.find((s) => !s.current)!;

    // Another user cannot end it (404, not 403: existence is not revealed).
    await b.delete(`/auth/sessions/${other.id}`).expect(404);
    await a2.get('/auth/me').expect(200);

    await a1.delete(`/auth/sessions/${other.id}`).expect(204);
    await a2.get('/auth/me').expect(401);
    expect((await a1.get('/auth/security').expect(200)).body.sessions).toHaveLength(1);
  });
});
