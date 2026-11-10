import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { totp } from '../src/identity/totp';
import { fake, installDefaultAgents } from './ai-fake';
import { PASSWORD, client, outbox, ownerQuery, registerCompany, resetDb, startApp, type TestClient } from './helpers';

let app: INestApplication;
let op: TestClient; // platform operator (also owns a company of their own)
let acme: { client: TestClient; tenantId: string };

beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  outbox(app).length = 0;
  fake(app).reset();
  installDefaultAgents(fake(app));
  ({ client: op } = await registerCompany(app, { email: 'ops@rakan.sa', company: 'Rakan Ops' }));
  await ownerQuery("UPDATE users SET is_platform_admin = true WHERE email = 'ops@rakan.sa'");
  acme = await registerCompany(app, { email: 'owner@acme.sa', company: 'Acme' });
});

const setPlanLimits = (key: string, limits: object) =>
  ownerQuery(`UPDATE plans SET limits = limits || $2::jsonb WHERE key = $1`, [key, JSON.stringify(limits)]);

describe('plans and subscriptions', () => {
  it('a new company starts a 14-day trial on Team', async () => {
    const plan = (await acme.client.get('/tenant/plan').expect(200)).body;
    expect(plan).toMatchObject({ status: 'trial', plan: { key: 'team', limits: { users: 5 } } });
    expect(new Date(plan.trialEndsAt).getTime() - Date.now()).toBeGreaterThan(13 * 86400_000);
    expect((await acme.client.get('/auth/me').expect(200)).body.activeTenant.status).toBe('trial');
  });
});

describe('platform console', () => {
  it('is refused to company owners and open to operators', async () => {
    await acme.client.get('/platform/overview').expect(403);
    const o = (await op.get('/platform/overview').expect(200)).body;
    expect(o.tenants).toMatchObject({ total: 2, trial: 2 });
    expect(o.byPlan).toEqual([expect.objectContaining({ key: 'team', tenants: 2 })]);
  });

  it('shows usage numbers but never company content', async () => {
    await acme.client.post('/crm/accounts', { name: 'عميل سري جداً', city: 'جدة' }).expect(201);
    const list = (await op.get('/platform/tenants').expect(200)).body;
    const row = list.find((t: { name: string }) => t.name === 'Acme');
    expect(row).toMatchObject({ ownerEmail: 'owner@acme.sa', usage: { accounts: 1, activeUsers: 1 }, plan: { key: 'team' } });
    expect(JSON.stringify(list)).not.toContain('عميل سري جداً');
    expect((await op.get(`/platform/tenants?q=acm`).expect(200)).body).toHaveLength(1);
  });

  it('suspends and reactivates a company (with a reason), visible in both audit logs', async () => {
    await op.patch(`/platform/tenants/${acme.tenantId}/subscription`, { status: 'suspended' }).expect(400); // reason required
    await op.patch(`/platform/tenants/${acme.tenantId}/subscription`, { status: 'suspended', reason: 'تعثر السداد' }).expect(200);
    expect((await acme.client.get('/crm/accounts').expect(403)).body.error.code).toBe('TENANT_SUSPENDED');
    expect((await acme.client.get('/auth/me').expect(200)).body.activeTenant.status).toBe('suspended');
    const companyAudit = await ownerQuery<{ action: string }>('SELECT action FROM audit_logs WHERE tenant_id = $1', [acme.tenantId]);
    expect(companyAudit.map((x) => x.action)).toContain('platform.subscription.update');
    await op.patch(`/platform/tenants/${acme.tenantId}/subscription`, { status: 'active', reason: 'تم السداد' }).expect(200);
    await acme.client.get('/crm/accounts').expect(200);
    const log = (await op.get('/platform/audit').expect(200)).body;
    expect(log[0]).toMatchObject({ action: 'platform.subscription.update', tenantName: 'Acme', actorName: 'Owner Rakan Ops' });
    expect(log[0].after).toMatchObject({ status: 'active', reason: 'تم السداد' });
  });

  it('changes the plan and edits plans', async () => {
    const plans = (await op.get('/platform/plans').expect(200)).body as { id: string; key: string }[];
    const business = plans.find((p) => p.key === 'business')!;
    const t = (await op.patch(`/platform/tenants/${acme.tenantId}/subscription`, { planId: business.id, status: 'active', reason: 'ترقية' }).expect(200)).body;
    expect(t.plan.key).toBe('business');
    await op.post('/platform/plans', { key: 'team', nameAr: 'x', nameEn: 'x', priceSarMonthly: 1, limits: { users: 1, aiMonthlyUsd: 1, storageMb: 1, recordingMinutes: 1 } }).expect(409);
    await op.post('/platform/plans', { key: 'pilot', nameAr: 'تجريبي انجزني', nameEn: 'Pilot', priceSarMonthly: 0, limits: { users: 10, aiMonthlyUsd: 50, storageMb: 5120, recordingMinutes: 1000 } }).expect(201);
    const updated = (await op.patch(`/platform/plans/${business.id}`, { priceSarMonthly: 1899 }).expect(200)).body;
    expect(updated.find((p: { key: string }) => p.key === 'business').priceSarMonthly).toBe(1899);
  });
});

describe('limits are enforced', () => {
  it('users: invitations stop at the plan limit', async () => {
    await setPlanLimits('team', { users: 2 });
    await acme.client.post('/team/invitations', { email: 'a@acme.sa', role: 'rep' }).expect(201);
    const res = await acme.client.post('/team/invitations', { email: 'b@acme.sa', role: 'rep' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_LIMIT_USERS');
    const plan = (await acme.client.get('/tenant/plan').expect(200)).body;
    expect(plan.alerts).toEqual([]); // 1 active user of 2 = 50% (pending invites are not "used" seats)
  });

  it('AI: the plan caps the company budget', async () => {
    await setPlanLimits('team', { aiMonthlyUsd: 0 });
    const a = (await acme.client.post('/crm/accounts', { name: 'عميل' }).expect(201)).body;
    expect((await acme.client.post(`/ai/accounts/${a.id}/score`).expect(402)).body.error.code).toBe('AI_BUDGET_EXCEEDED');
    expect((await acme.client.get('/ai/settings').expect(200)).body.usage.budgetUsd).toBe(0);
    await setPlanLimits('team', { aiMonthlyUsd: null });
    await acme.client.post(`/ai/accounts/${a.id}/score`).expect(201);
  });

  it('storage: recordings stop at the plan limit', async () => {
    await setPlanLimits('team', { storageMb: 0 });
    await acme.client.patch('/tenant', { settings: { recordingEnabled: true } }).expect(200);
    const a = (await acme.client.post('/crm/accounts', { name: 'عميل' }).expect(201)).body;
    const v = (await acme.client.post('/crm/visits', { accountId: a.id, scheduledStart: new Date(Date.now() + 3600_000).toISOString() }).expect(201)).body;
    const r = await acme.client.post(`/crm/visits/${v.id}/recordings`, { mimeType: 'audio/webm', totalChunks: 1, consent: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PLAN_LIMIT_STORAGE');
  });
});

describe('two-step verification for operators', () => {
  it('is required when configured (always in production)', async () => {
    const strict = await startApp({ PLATFORM_ADMIN_REQUIRE_MFA: 'true' });
    try {
      const c = await client(strict);
      await c.post('/auth/login', { email: 'ops@rakan.sa', password: PASSWORD }).expect(200);
      expect((await c.get('/platform/overview').expect(403)).body.error.code).toBe('PLATFORM_MFA_REQUIRED');
      const { secret } = (await c.post('/auth/mfa/setup').expect(200)).body;
      await c.post('/auth/mfa/enable', { code: totp(secret) }).expect(200);
      await c.get('/platform/overview').expect(200);
    } finally {
      await strict.close();
    }
  });
});
