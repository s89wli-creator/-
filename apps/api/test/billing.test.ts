import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addPeriod, priceBreakdown } from '../src/billing/billing.service';
import request from 'supertest';
import { EdfaPayProvider, FakePaymentProvider, PAYMENT_PROVIDER, hmacHex } from '../src/billing/payment.provider';
import { addMember, outbox, ownerQuery, registerCompany, resetDb, startApp, type TestClient } from './helpers';

let app: INestApplication;
let owner: TestClient;
let op: TestClient;
let tenantId: string;
const pay = () => app.get(PAYMENT_PROVIDER) as FakePaymentProvider;
const numberOf = async (invoiceId: string) => (await ownerQuery<{ n: string }>('SELECT number AS n FROM billing_invoices WHERE id = $1', [invoiceId]))[0]!.n;
const PHONE = '055 123 4567';
/** EdfaPay notification: text/plain JSON, signed HMAC-SHA256 (hex) over the raw body; no cookies, no CSRF. */
const notify = (body: object | string, secret = 'whsec_test_secret') => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return request(app.getHttpServer()).post('/api/public/billing/edfapay/webhook').set('content-type', 'text/plain').set('x-edfapay-signature', hmacHex(secret, raw)).send(raw);
};
const event = (orderId: string, transactionId: string, over: object = {}) => ({
  transactionId, orderId, amount: 1, currencyCode: '682', status: 'Approved', channel: 'Payment Gateway', type: 'Purchase', ...over,
});
/** Customer pays on the hosted page and EdfaPay notifies us. */
const payAndNotify = async (invoiceId: string, over: Parameters<FakePaymentProvider['pay']>[1] = {}) => {
  const n = await numberOf(invoiceId);
  const t = pay().pay(n, over);
  await notify(event(n, t.id)).expect(200);
  return t;
};
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
  pay().transactions.clear();
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
    await manager.post('/billing/checkout', { planKey: 'team', period: 'month', phone: PHONE }).expect(403);
    expect((await owner.post('/billing/checkout', { planKey: 'team', period: 'month', phone: '12345' }).expect(400)).body.error.code).toBe('VALIDATION_ERROR');

    const c = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month', phone: PHONE, amount: 1 } as object).expect(201)).body;
    expect(c.paymentUrl).toMatch(/^https:\/\/pay\.example\.test\//);
    const sent = pay().created.at(-1)!;
    expect(sent).toMatchObject({ orderId: await numberOf(c.invoiceId), amount: 103385, currency: 'SAR', customer: { email: 'owner@acme.sa', phone: '+966551234567' } });
    expect(sent.orderId).toMatch(/^RKN-\d{4}-\d{6}$/);
    expect(sent.successUrl).toBe(`http://localhost:3000/settings/billing?invoice=${c.invoiceId}`);
    expect(sent.failureUrl).toBe(`http://localhost:3000/settings/billing?invoice=${c.invoiceId}&canceled=1`);

    // Double click: the same unpaid link is reused.
    expect((await owner.post('/billing/checkout', { planKey: 'team', period: 'month', phone: PHONE }).expect(201)).body.invoiceId).toBe(c.invoiceId);
    expect(pay().created).toHaveLength(1);
    expect((await owner.post('/billing/checkout', { planKey: 'enterprise', period: 'month', phone: PHONE }).expect(422)).body.error.code).toBe('PLAN_NOT_PURCHASABLE');
    expect((await owner.post('/billing/checkout', { planKey: 'team', period: 'year', phone: PHONE }).expect(422)).body.error.code).toBe('PLAN_NOT_PURCHASABLE');
  });
});

describe('payment confirmation', () => {
  it('counts only after EdfaPay confirms; trial becomes active, once, with receipt', async () => {
    const c = (await owner.post('/billing/checkout', { planKey: 'business', period: 'month', phone: PHONE }).expect(201)).body;
    expect((await owner.post(`/billing/invoices/${c.invoiceId}/verify`).expect(200)).body.status).toBe('pending'); // not paid yet
    expect(await status()).toBe('trial');

    const t = await payAndNotify(c.invoiceId);
    const v = (await owner.post(`/billing/invoices/${c.invoiceId}/verify`).expect(200)).body;
    expect(v).toMatchObject({ status: 'paid', planKey: 'business', total: 2068.85 });
    const s = await sub();
    expect(s.key).toBe('business');
    expect(s.trial_ends_at).toBeNull();
    expect(Math.round((s.current_period_end!.getTime() - Date.now()) / 86400_000)).toBeGreaterThanOrEqual(28);
    expect(await status()).toBe('active');

    // Repeated confirmations (notification retry, refresh) do not extend twice.
    const end = s.current_period_end!.getTime();
    await owner.post(`/billing/invoices/${c.invoiceId}/verify`).expect(200);
    await notify(event(await numberOf(c.invoiceId), t.id)).expect(200);
    await notify(event(await numberOf(c.invoiceId), t.id, { status: 'Pending' })).expect(200); // late, out of order
    expect((await sub()).current_period_end!.getTime()).toBe(end);

    const mail = outbox(app).find((m) => m.to === 'owner@acme.sa' && m.subject.includes('إيصال'))!;
    expect(mail.text).toContain('2,068.85'.replace(',', '')); // 2068.85
    expect(mail.text).toContain('إيصال دفع');
    expect((await owner.get('/notifications').expect(200)).body.items[0].title).toContain('تم استلام دفعة الاشتراك');
    const audit = await ownerQuery<{ action: string }>("SELECT action FROM audit_logs WHERE tenant_id = $1 AND action LIKE 'billing.%' ORDER BY id", [tenantId]);
    expect(audit.map((a) => a.action)).toEqual(['billing.checkout', 'billing.paid']);
  });

  it('a renewal of the same plan starts when the paid period ends', async () => {
    const a = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month', phone: PHONE }).expect(201)).body;
    await payAndNotify(a.invoiceId);
    const firstEnd = (await sub()).current_period_end!;
    const b = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month', phone: PHONE }).expect(201)).body;
    await payAndNotify(b.invoiceId);
    const second = (await owner.post(`/billing/invoices/${b.invoiceId}/verify`).expect(200)).body;
    expect(new Date(second.periodStart).getTime()).toBe(firstEnd.getTime());
    expect((await sub()).current_period_end!.getTime()).toBe(addPeriod(firstEnd, 'month').getTime());
  });

  it('rejects a paid invoice with a different amount and leaves the subscription alone', async () => {
    const c = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month', phone: PHONE }).expect(201)).body;
    await payAndNotify(c.invoiceId, { amount: 100 });
    expect((await owner.post(`/billing/invoices/${c.invoiceId}/verify`).expect(200)).body.status).toBe('failed');
    expect(await status()).toBe('trial');
    expect((await ownerQuery<{ action: string }>("SELECT action FROM platform_audit WHERE action = 'billing.check_failed'")).length).toBe(1);
  });
});

describe('EdfaPay notifications', () => {
  it('needs a valid signature, needs no CSRF, is handled once, and re-checks with EdfaPay', async () => {
    const c = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month', phone: PHONE }).expect(201)).body;
    const n = await numberOf(c.invoiceId);
    expect((await notify(event(n, 'tx-1'), 'wrong-secret').expect(401)).body.error.code).toBe('INVALID_SIGNATURE');
    await request(app.getHttpServer()).post('/api/public/billing/edfapay/webhook').set('content-type', 'text/plain').send(JSON.stringify(event(n, 'tx-1'))).expect(401);
    await notify('not json').expect(400);

    // Claims "Approved" but EdfaPay does not know the transaction: nothing happens.
    await notify(event(n, 'tx-forged')).expect(200);
    expect(await status()).toBe('trial');

    // Declined card: the invoice stays open so the customer can retry.
    const d = pay().pay(n, { outcome: 'declined', rawStatus: 'FAILED/DECLINED' });
    await notify(event(n, d.id, { status: 'Declined' })).expect(200);
    expect((await owner.post(`/billing/invoices/${c.invoiceId}/verify`).expect(200)).body.status).toBe('pending');

    const t = pay().pay(n);
    await notify(event(n, t.id)).expect(200);
    expect(await status()).toBe('active');
    const end = (await sub()).current_period_end!.getTime();
    await notify(event(n, t.id)).expect(200); // retry of the same notification
    expect((await sub()).current_period_end!.getTime()).toBe(end);
    expect((await ownerQuery<{ outcome: string }>('SELECT outcome FROM billing_events WHERE event_id = $1', [`${t.id}:${n}:Purchase:Approved`]))[0]!.outcome).toBe('paid');

    // A transaction for another order cannot pay this invoice.
    const other = (await owner.post('/billing/checkout', { planKey: 'business', period: 'month', phone: PHONE }).expect(201)).body;
    await notify(event(await numberOf(other.invoiceId), t.id, { status: 'Approved', type: 'Purchase', channel: 'x' })).expect(200);
    expect((await owner.post(`/billing/invoices/${other.invoiceId}/verify`).expect(200)).body.status).toBe('failed');

    await notify(event(n, 'tx-r1', { type: 'Refund' })).expect(200);
    expect((await ownerQuery("SELECT 1 FROM platform_audit WHERE action = 'billing.refunded'")).length).toBe(1);
    await notify(event('RKN-0000-000000', 'tx-x')).expect(200); // unknown order: acknowledged, ignored
  });

  it('a suspended company can still pay (but stays suspended until the platform decides)', async () => {
    await ownerQuery("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantId]);
    await owner.get('/crm/accounts').expect(403);
    await owner.get('/billing').expect(200);
    const c = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month', phone: PHONE }).expect(201)).body;
    await payAndNotify(c.invoiceId);
    expect(await status()).toBe('suspended');
    expect((await owner.get('/notifications').expect(200)).body.items[0].body).toContain('سيراجعه فريق راكان');
  });

  it('yearly prices are set by the platform; operators see all payments', async () => {
    const plans = (await op.get('/platform/plans').expect(200)).body as { id: string; key: string }[];
    await op.patch(`/platform/plans/${plans.find((p) => p.key === 'team')!.id}`, { priceSarYearly: 8990 }).expect(200);
    const c = (await owner.post('/billing/checkout', { planKey: 'team', period: 'year', phone: PHONE }).expect(201)).body;
    expect(pay().created.at(-1)!.amount).toBe(1033850);
    await owner.get('/platform/billing/invoices').expect(403);
    const all = (await op.get('/platform/billing/invoices').expect(200)).body;
    expect(all[0]).toMatchObject({ id: c.invoiceId, tenantName: 'Acme', period: 'year', total: 10338.5 });
  });
});

describe('EdfaPay adapter (HTTP shape, no network)', () => {
  it('sends the documented initiate request and maps transaction status', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const replies: object[] = [
      { code: 200, message: 'Success', errorCode: null, data: { redirectUrl: 'https://app.edfapay.com/pay/checkout?sessionId=abc-123' } },
      { code: 200, data: { content: [{ transactionId: 'tx-9', orderId: 'RKN-2026-000001', amount: '1033.85', currencyCode: '682', transactionStatus: 'FAILED', paymentStatus: 'DECLINED', transactionType: 'PURCHASE' }] } },
    ];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const p = new EdfaPayProvider('key-1', 'sec', 'sandbox');
      const co = await p.createCheckout({
        orderId: 'RKN-2026-000001', amount: 103385, currency: 'SAR', customer: { name: 'A', email: 'a@b.sa', phone: '+966551234567' },
        successUrl: 'https://x/ok', failureUrl: 'https://x/no', expiresAt: new Date('2026-12-01T00:00:00Z'),
      });
      expect(co).toEqual({ url: 'https://app.edfapay.com/pay/checkout?sessionId=abc-123', sessionId: 'abc-123' });
      expect(calls[0]!.url).toBe('https://demo-api.edfapay.com/api/v1/payment-gateway/initiate');
      expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('key-1');
      expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ orderId: 'RKN-2026-000001', currency: 'SAR', amount: '1033.85', auth: 'N', expireDate: '2026-12-01' });

      const t = await p.getTransaction('tx-9');
      expect(calls[1]!.url).toBe('https://demo-api.edfapay.com/api/v1/transactions/filterTransaction?id=tx-9');
      expect(t).toMatchObject({ outcome: 'declined', amount: 103385, currency: 'SAR', orderId: 'RKN-2026-000001' });
      expect(new EdfaPayProvider('k', undefined, 'live').verifySignature(Buffer.from('{}'), hmacHex('x', '{}'))).toBe(false); // no secret: refuse
      expect(p.verifySignature(Buffer.from('{}'), hmacHex('sec', '{}').toUpperCase())).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('an unpaid link closes after its lifetime', async () => {
    const c = (await owner.post('/billing/checkout', { planKey: 'team', period: 'month', phone: PHONE }).expect(201)).body;
    await ownerQuery("UPDATE billing_invoices SET created_at = now() - interval '4 days' WHERE id = $1", [c.invoiceId]);
    expect((await owner.post(`/billing/invoices/${c.invoiceId}/verify`).expect(200)).body.status).toBe('expired');
  });
});
