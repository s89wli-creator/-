import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addPeriod, priceBreakdown } from '../src/billing/billing.service';
import { FakePaymentProvider, PAYMENT_PROVIDER } from '../src/billing/payment.provider';
import { addMember, client, outbox, ownerQuery, registerCompany, resetDb, startApp, type TestClient } from './helpers';

let app: INestApplication;
let owner: TestClient;
let op: TestClient;
let tenantId: string;
const pay = () => app.get(PAYMENT_PROVIDER) as FakePaymentProvider;
const providerId = async (invoiceId: string) => (await ownerQuery<{ p: string }>('SELECT provider_invoice_id AS p FROM billing_invoices WHERE id = $1', [invoiceId]))[0]!.p;
const sub = async () => (await ownerQuery<{ current_period_end: Date | null; trial_ends_at: Date | null; key: string }>(
  'SELECT s.current_period_end, s.trial_ends_at, p.key FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $1', [tenantId]))[0]!;
const status = async () => (await ownerQuery<{ status: string }>('SELECT status FROM tenants WHERE id = $1', [tenantId]))[0]!.status;

beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  outbox(app).length = 0;
  pay().invoices.clear();
  pay().created.length = 0;
  ({ client: op } = await registerCompany(app, { email: 'ops@rakan.sa', company: 'Rakan Ops' }));
  await ownerQuery("UPDATE users SET is_platform_admin = true WHERE email = 'ops@rakan.sa'");
  ({ client: owner, tenantId } = await registerCompany(app, { email: 'owner@acme.sa', company: 'Acme' }));
});

describe('amounts and periods', () => {
  it('adds 15% VAT in halalas and extends by calendar month/year', () => {
    expect(priceBreakdown(899)).toEqual({ subtotal: 89900, vat: 13485, total: 103385 });
    expect(priceBreakdown(399.99)).toEqual({ subtotal: 39999, vat: 6000, total: 45999 });
    expect(addPeriod(new Date('2026-01-31T10:00:00Z'), 'month').toISOString()).toBe('2026-03-03T10:00:00.000Z');
    expect(addPeriod(new Date('2026-11-28T10:00:00Z'), 'year').toISOString()).toBe('2027-11-28T10:00:00.000Z');
  });
});

describe('checkout', () => {
  it('only owners pay; the amount comes from the plan price, not the browser', async () => {
    const o = (await owner.get('/billing').expect(200)).body;
    expect(o).toMatchObject({ providerReady: true, canPay: true, vatRate: 15, subscription: { planKey: 'team', status: 'trial', needsPayment: false } });
    const { client: manager } = await addMember(app, owner, 'm@acme.sa', 'manager');
    expect((await manager.get('/billing').expect(200)).body.canPay).toBe(false);
    await manager.post('/billing/checkout', { planKey: 'team', period: 'month' }).expect(403);

    const c = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month', amount: 1 } as object).expect(201)).body;
    expect(c.paymentUrl).toMatch(/^https:\/\/pay\.example\.test\//);
    const sent = pay().created.at(-1)!;
    expect(sent).toMatchObject({ amount: 103385, currency: 'SAR', metadata: { rakan_invoice_id: c.invoiceId, tenant_id: tenantId } });
    expect(sent.successUrl).toBe(`http://localhost:3000/settings/billing?invoice=${c.invoiceId}`);
    expect(sent.callbackUrl).toBe('http://localhost:3000/api/public/billing/moyasar/callback');
    expect(sent.description).toContain('Acme');

    // Double click: the same unpaid link is reused.
    expect((await owner.post('/billing/checkout', { planKey: 'team', period: 'month' }).expect(201)).body.invoiceId).toBe(c.invoiceId);
    expect(pay().created).toHaveLength(1);
    expect((await owner.post('/billing/checkout', { planKey: 'enterprise', period: 'month' }).expect(422)).body.error.code).toBe('PLAN_NOT_PURCHASABLE');
    expect((await owner.post('/billing/checkout', { planKey: 'team', period: 'year' }).expect(422)).body.error.code).toBe('PLAN_NOT_PURCHASABLE');
  });
});

describe('payment confirmation', () => {
  it('counts only after Moyasar confirms; trial becomes active, once, with receipt', async () => {
    const c = (await owner.post('/billing/checkout', { planKey: 'business', period: 'month' }).expect(201)).body;
    expect((await owner.post(`/billing/invoices/${c.invoiceId}/verify`).expect(200)).body.status).toBe('pending'); // not paid yet
    expect(await status()).toBe('trial');

    pay().pay(await providerId(c.invoiceId));
    const v = (await owner.post(`/billing/invoices/${c.invoiceId}/verify`).expect(200)).body;
    expect(v).toMatchObject({ status: 'paid', planKey: 'business', total: 2068.85 });
    const s = await sub();
    expect(s.key).toBe('business');
    expect(s.trial_ends_at).toBeNull();
    expect(Math.round((s.current_period_end!.getTime() - Date.now()) / 86400_000)).toBeGreaterThanOrEqual(28);
    expect(await status()).toBe('active');

    // Second confirmation (webhook/callback/refresh) does not extend twice.
    const end = s.current_period_end!.getTime();
    await owner.post(`/billing/invoices/${c.invoiceId}/verify`).expect(200);
    await (await client(app)).post('/public/billing/moyasar/callback', { id: await providerId(c.invoiceId) }).expect(200);
    expect((await sub()).current_period_end!.getTime()).toBe(end);

    const mail = outbox(app).find((m) => m.to === 'owner@acme.sa' && m.subject.includes('إيصال'))!;
    expect(mail.text).toContain('2,068.85'.replace(',', '')); // 2068.85
    expect(mail.text).toContain('إيصال دفع');
    expect((await owner.get('/notifications').expect(200)).body.items[0].title).toContain('تم استلام دفعة الاشتراك');
    const audit = await ownerQuery<{ action: string }>("SELECT action FROM audit_logs WHERE tenant_id = $1 AND action LIKE 'billing.%' ORDER BY id", [tenantId]);
    expect(audit.map((a) => a.action)).toEqual(['billing.checkout', 'billing.paid']);
  });

  it('a renewal of the same plan starts when the paid period ends', async () => {
    const a = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month' }).expect(201)).body;
    pay().pay(await providerId(a.invoiceId));
    await owner.post(`/billing/invoices/${a.invoiceId}/verify`).expect(200);
    const firstEnd = (await sub()).current_period_end!;
    const b = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month' }).expect(201)).body;
    pay().pay(await providerId(b.invoiceId));
    const second = (await owner.post(`/billing/invoices/${b.invoiceId}/verify`).expect(200)).body;
    expect(new Date(second.periodStart).getTime()).toBe(firstEnd.getTime());
    expect((await sub()).current_period_end!.getTime()).toBe(addPeriod(firstEnd, 'month').getTime());
  });

  it('rejects a paid invoice with a different amount and leaves the subscription alone', async () => {
    const c = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month' }).expect(201)).body;
    pay().pay(await providerId(c.invoiceId), { amount: 100 });
    expect((await owner.post(`/billing/invoices/${c.invoiceId}/verify`).expect(200)).body.status).toBe('failed');
    expect(await status()).toBe('trial');
    expect((await ownerQuery<{ action: string }>("SELECT action FROM platform_audit WHERE action = 'billing.check_failed'")).length).toBe(1);
  });
});

describe('Moyasar notifications', () => {
  const event = (over: object) => ({ id: `evt-${Math.random()}`, type: 'payment_paid', live: false, secret_token: 'whsec_test_secret', data: {}, ...over });

  it('webhook needs the shared secret, is handled once, and re-checks with Moyasar', async () => {
    const anon = await client(app);
    const c = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month' }).expect(201)).body;
    const pid = await providerId(c.invoiceId);
    await anon.post('/public/billing/moyasar/webhook', event({ secret_token: 'wrong', data: { invoice_id: pid } })).expect(401);

    // Claims "paid" but Moyasar says not yet: nothing happens.
    await anon.post('/public/billing/moyasar/webhook', event({ data: { invoice_id: pid } })).expect(200);
    expect(await status()).toBe('trial');

    pay().pay(pid);
    const e = event({ id: 'evt-paid-1', data: { invoice_id: pid } });
    await anon.post('/public/billing/moyasar/webhook', e).expect(200);
    expect(await status()).toBe('active');
    const end = (await sub()).current_period_end!.getTime();
    await anon.post('/public/billing/moyasar/webhook', e).expect(200); // retry of the same event
    expect((await sub()).current_period_end!.getTime()).toBe(end);
    expect((await ownerQuery<{ outcome: string }>("SELECT outcome FROM billing_events WHERE event_id = 'evt-paid-1'"))[0]!.outcome).toBe('paid');

    await anon.post('/public/billing/moyasar/webhook', event({ type: 'webhook_verification', data: { verification_code: '123456' } })).expect(200);
    expect((await ownerQuery<{ after: { code: string } }>("SELECT after FROM platform_audit WHERE action = 'billing.webhook_verification'"))[0]!.after.code).toBe('123456');
    await anon.post('/public/billing/moyasar/callback', { id: 'unknown-invoice' }).expect(200);
  });

  it('a suspended company can still pay (but stays suspended until the platform decides)', async () => {
    await ownerQuery("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantId]);
    await owner.get('/crm/accounts').expect(403);
    await owner.get('/billing').expect(200);
    const c = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month' }).expect(201)).body;
    pay().pay(await providerId(c.invoiceId));
    await owner.post(`/billing/invoices/${c.invoiceId}/verify`).expect(200);
    expect(await status()).toBe('suspended');
    expect((await owner.get('/notifications').expect(200)).body.items[0].body).toContain('سيراجعه فريق راكان');
  });

  it('yearly prices are set by the platform; operators see all payments', async () => {
    const plans = (await op.get('/platform/plans').expect(200)).body as { id: string; key: string }[];
    await op.patch(`/platform/plans/${plans.find((p) => p.key === 'team')!.id}`, { priceSarYearly: 8990 }).expect(200);
    const c = (await owner.post('/billing/checkout', { planKey: 'team', period: 'year' }).expect(201)).body;
    expect(pay().created.at(-1)!.amount).toBe(1033850);
    await owner.get('/platform/billing/invoices').expect(403);
    const all = (await op.get('/platform/billing/invoices').expect(200)).body;
    expect(all[0]).toMatchObject({ id: c.invoiceId, tenantName: 'Acme', period: 'year', total: 10338.5 });
  });
});
