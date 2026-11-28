import { expect } from 'vitest';
import type { CrmFixtures } from './crm-probes';
import { ownerQuery, type TestClient } from './helpers';

export interface FilesFixtures { a: TestClient; b: TestClient; B: { attachmentId: string; accountId: string; endpoint: string; billingInvoiceId: string } }

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('ملف سري للشركة ب'), Buffer.alloc(500, 32)]);

export async function createFilesFixtures(crm: CrmFixtures): Promise<FilesFixtures> {
  const { a, b } = crm;
  const att = (await b.uploadWith('/crm/attachments', { entityType: 'account', entityId: crm.B.accountId }, PDF, 'سري-ب.pdf').expect(201)).body;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 2)]);
  await b.uploadWith('/tenant/logo', {}, png, 'b.png').expect(200);
  const endpoint = 'https://push.example.com/b-device';
  await b.post('/push/subscriptions', { endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'b'.repeat(22) } }).expect(200);
  const bill = (await b.post('/billing/checkout', { planKey: 'team', period: 'month' }).expect(201)).body;
  return { a, b, B: { attachmentId: att.id, accountId: crm.B.accountId, endpoint, billingInvoiceId: bill.invoiceId } };
}

export function filesProbes(f: () => FilesFixtures): Record<string, () => Promise<void>> {
  const alive = async () => (await ownerQuery('SELECT 1 FROM attachments WHERE id = $1 AND deleted_at IS NULL', [f().B.attachmentId])).length;
  return {
    'GET /api/crm/attachments': async () => {
      await f().a.get(`/crm/attachments?entityType=account&entityId=${f().B.accountId}`).expect(404);
    },
    'POST /api/crm/attachments': async () => {
      await f().a.uploadWith('/crm/attachments', { entityType: 'account', entityId: f().B.accountId }, PDF, 'x.pdf').expect(404);
      expect((await ownerQuery('SELECT 1 FROM attachments WHERE account_id = $1', [f().B.accountId])).length).toBe(1);
    },
    'GET /api/crm/attachments/:id/file': async () => {
      await f().a.get(`/crm/attachments/${f().B.attachmentId}/file`).expect(404);
    },
    'DELETE /api/crm/attachments/:id': async () => {
      await f().a.delete(`/crm/attachments/${f().B.attachmentId}`).expect(404);
      expect(await alive()).toBe(1);
    },
    'GET /api/tenant/logo': async () => {
      await f().a.get('/tenant/logo').expect(404); // B's logo is not A's
    },
    'POST /api/tenant/logo': async () => {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 3)]);
      await f().a.uploadWith('/tenant/logo', {}, png, 'a.png').expect(200);
      expect((await f().b.get('/tenant/logo').expect(200)).headers['content-length']).toBe('108');
      await f().a.delete('/tenant/logo').expect(204);
    },
    'DELETE /api/tenant/logo': async () => {
      await f().a.delete('/tenant/logo').expect(204);
      await f().b.get('/tenant/logo').expect(200);
    },
    'GET /api/billing': async () => {
      expect(JSON.stringify((await f().a.get('/billing').expect(200)).body)).not.toContain(f().B.billingInvoiceId);
    },
    'POST /api/billing/checkout': async () => {
      const mine = (await f().a.post('/billing/checkout', { planKey: 'team', period: 'month' }).expect(201)).body;
      expect(mine.invoiceId).not.toBe(f().B.billingInvoiceId);
      const [row] = await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM billing_invoices WHERE tenant_id = (SELECT tenant_id FROM billing_invoices WHERE id = $1)', [f().B.billingInvoiceId]);
      expect(row!.n).toBe(1);
    },
    'GET /api/billing/invoices/:id': async () => {
      await f().a.get(`/billing/invoices/${f().B.billingInvoiceId}`).expect(404);
    },
    'POST /api/billing/invoices/:id/verify': async () => {
      await f().a.post(`/billing/invoices/${f().B.billingInvoiceId}/verify`).expect(404);
    },
    'GET /api/push': async () => {
      expect((await f().a.get('/push').expect(200)).body.devices).toBe(0);
    },
    'POST /api/push/subscriptions': async () => {
      // Registering B's endpoint from A only creates a row in A (the browser belongs to whoever signs in there).
      await f().a.post('/push/subscriptions', { endpoint: f().B.endpoint, keys: { p256dh: 'A'.repeat(87), auth: 'a'.repeat(22) } }).expect(200);
      const rows = await ownerQuery<{ p256dh: string }>('SELECT p256dh FROM push_subscriptions WHERE endpoint = $1 ORDER BY p256dh', [f().B.endpoint]);
      expect(rows.map((r) => r.p256dh[0])).toEqual(['A', 'B']);
      await f().a.post('/push/subscriptions/remove', { endpoint: f().B.endpoint }).expect(204);
    },
    'POST /api/push/subscriptions/remove': async () => {
      await f().a.post('/push/subscriptions/remove', { endpoint: f().B.endpoint }).expect(204);
      expect((await ownerQuery("SELECT 1 FROM push_subscriptions WHERE endpoint = $1 AND p256dh LIKE 'B%'", [f().B.endpoint])).length).toBe(1);
    },
  };
}
