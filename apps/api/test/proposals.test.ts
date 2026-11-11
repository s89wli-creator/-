import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeTotals } from '../src/proposals/proposals.service';
import { fake, installDefaultAgents } from './ai-fake';
import { addMember, client, outbox, ownerQuery, registerCompany, resetDb, startApp, type TestClient } from './helpers';

let app: INestApplication;
let owner: TestClient;
let tenantId: string;
let accountId: string;
let contactId: string;
let price: { id: string };

async function approved(c: TestClient, item: object) {
  const it = (await c.post('/brain/items', item).expect(201)).body;
  await c.post(`/brain/items/${it.id}/approve`).expect(200);
  return it;
}
const tokenOf = (url: string) => url.split('/p/')[1]!;

beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  outbox(app).length = 0;
  fake(app).reset();
  installDefaultAgents(fake(app));
  ({ client: owner, tenantId } = await registerCompany(app, { email: 'owner@acme.sa', company: 'شركة أكمي للنقل' }));
  accountId = (await owner.post('/crm/accounts', { name: 'مصنع الدمام', city: 'الدمام' }).expect(201)).body.id;
  contactId = (await owner.post(`/crm/accounts/${accountId}/contacts`, { fullName: 'أحمد المشتري', email: 'buyer@factory.sa' }).expect(201)).body.id;
  price = await approved(owner, { section: 'pricing', title: 'سعر النقل المبرد', fields: { product: 'نقل مبرد الرياض-الدمام', price: 1200, unit: 'رحلة' } });
});

describe('totals', () => {
  it('discounts per line, then 15% VAT on the subtotal, rounded to halalas', () => {
    const t = computeTotals([{ quantity: 3, unitPrice: 1200, discountPct: 10 }, { quantity: 1, unitPrice: 99.99, discountPct: 0 }]);
    expect(t).toMatchObject({ subtotal: 3339.99, discountTotal: 360, vatAmount: 501, total: 3840.99 });
  });
});

describe('proposals', () => {
  it('prices lines from the approved price list (the client cannot set a list price) and numbers them per company', async () => {
    const p = (await owner.post('/crm/proposals', {
      accountId, contactId, title: 'عرض نقل', items: [{ brainItemId: price.id, quantity: 3, unitPrice: 1 }, { name: 'تأمين إضافي', quantity: 1, unitPrice: 150 }],
    }).expect(201)).body;
    expect(p.number).toMatch(/^Q-\d{4}-0001$/);
    expect(p.items[0]).toMatchObject({ name: 'نقل مبرد الرياض-الدمام', unitPrice: 1200, priceSource: 'price_list', lineTotal: 3600 });
    expect(p.items[1]).toMatchObject({ priceSource: 'manual', lineTotal: 150 });
    expect(p).toMatchObject({ subtotal: 3750, vatAmount: 562.5, total: 4312.5, status: 'draft' });
    expect(p.warnings).toContainEqual({ code: 'manual_price', item: 'تأمين إضافي' });
    const second = (await owner.post('/crm/proposals', { accountId, title: 'عرض ثان' }).expect(201)).body;
    expect(second.number).toMatch(/-0002$/);
    expect(second.warnings).toContainEqual({ code: 'no_items' });
  });

  it('rejects unapproved prices and discounts above the approved limits', async () => {
    const draftPrice = (await owner.post('/brain/items', { section: 'pricing', title: 'غير معتمد', fields: { product: 'x', price: 5 } }).expect(201)).body;
    expect((await owner.post('/crm/proposals', { accountId, title: 'عرض', items: [{ brainItemId: draftPrice.id, quantity: 1 }] }).expect(422)).body.error.code).toBe('PRICE_NOT_APPROVED');
    expect((await owner.post('/crm/proposals', { accountId, title: 'عرض', items: [{ name: 'بلا سعر', quantity: 1 }] }).expect(400)).body.error.code).toBe('MANUAL_LINE_INCOMPLETE');

    // No discount policy yet: allowed, but flagged for the approver.
    const p = (await owner.post('/crm/proposals', { accountId, title: 'عرض', items: [{ brainItemId: price.id, quantity: 1, discountPct: 20 }] }).expect(201)).body;
    expect(p.warnings).toContainEqual({ code: 'no_discount_policy' });

    await approved(owner, { section: 'discount_rules', title: 'حدود الخصم', fields: { maxDiscountPctRep: 5, maxDiscountPctManager: 15 } });
    expect((await owner.post('/crm/proposals', { accountId, title: 'عرض', items: [{ brainItemId: price.id, quantity: 1, discountPct: 20 }] }).expect(422)).body.error.code).toBe('DISCOUNT_ABOVE_LIMIT');
    const { client: rep, membershipId } = await addMember(app, owner, 'rep@acme.sa', 'rep');
    await owner.patch(`/crm/accounts/${accountId}`, { ownerMembershipId: membershipId }).expect(200);
    expect((await rep.post('/crm/proposals', { accountId, title: 'عرض', items: [{ brainItemId: price.id, quantity: 1, discountPct: 10 }] }).expect(422)).body.error.details.limit).toBe(5);
    const ok = (await owner.post('/crm/proposals', { accountId, title: 'عرض', items: [{ brainItemId: price.id, quantity: 1, discountPct: 10 }] }).expect(201)).body;
    expect(ok.warnings).toContainEqual({ code: 'discount_above_rep_limit', item: 'نقل مبرد الرياض-الدمام', limit: 5 });
  });

  it('nothing reaches the customer before approval; approval issues the link and emails it', async () => {
    const p = (await owner.post('/crm/proposals', { accountId, contactId, title: 'عرض نقل', items: [{ brainItemId: price.id, quantity: 2 }] }).expect(201)).body;
    const sub = (await owner.post(`/crm/proposals/${p.id}/submit`).expect(200)).body;
    expect(sub).toMatchObject({ status: 'pending_approval', shareUrl: null });
    expect(outbox(app).filter((m) => m.to === 'buyer@factory.sa')).toHaveLength(0);
    await owner.patch(`/crm/proposals/${p.id}`, { title: 'تعديل' }).expect(409); // locked while waiting

    const approval = (await owner.get(`/approvals/${sub.approvalRequestId}`).expect(200)).body;
    expect(approval.summary).toContain('2,760');
    const done = (await owner.post(`/approvals/${sub.approvalRequestId}/decision`, { decision: 'approve' }).expect(200)).body;
    expect(done.status).toBe('executed');
    const sent = (await owner.get(`/crm/proposals/${p.id}`).expect(200)).body;
    expect(sent.status).toBe('sent');
    expect(sent.shareUrl).toMatch(/^http:\/\/localhost:3000\/p\/[A-Za-z0-9_-]{32}$/);
    const mail = outbox(app).find((m) => m.to === 'buyer@factory.sa')!;
    expect(mail.text).toContain(sent.shareUrl);
    const timeline = await ownerQuery<{ type: string }>('SELECT type FROM activities WHERE tenant_id = $1 ORDER BY id', [tenantId]);
    expect(timeline.map((t) => t.type)).toContain('proposal_sent');
  });

  it('a rejected approval returns the proposal to draft; a do-not-contact customer is never emailed', async () => {
    await owner.put(`/crm/contacts/${contactId}/dnc`, { doNotContact: true, reason: 'طلب العميل' }).expect(200);
    const p = (await owner.post('/crm/proposals', { accountId, contactId, title: 'عرض', items: [{ brainItemId: price.id, quantity: 1 }] }).expect(201)).body;
    expect(p.warnings).toContainEqual({ code: 'contact_dnc' });
    let sub = (await owner.post(`/crm/proposals/${p.id}/submit`).expect(200)).body;
    await owner.post(`/approvals/${sub.approvalRequestId}/decision`, { decision: 'reject', note: 'السعر' }).expect(200);
    expect((await owner.get(`/crm/proposals/${p.id}`).expect(200)).body.status).toBe('draft');
    sub = (await owner.post(`/crm/proposals/${p.id}/submit`).expect(200)).body;
    const res = (await owner.post(`/approvals/${sub.approvalRequestId}/decision`, { decision: 'approve' }).expect(200)).body;
    expect(res.executionResult).toMatchObject({ sent: true, emailed: false });
    expect(outbox(app).filter((m) => m.to === 'buyer@factory.sa')).toHaveLength(0);
  });

  it('the customer link shows only the approved proposal and records one decision', async () => {
    const p = (await owner.post('/crm/proposals', { accountId, contactId, title: 'عرض نقل', items: [{ brainItemId: price.id, quantity: 1 }] }).expect(201)).body;
    const sub = (await owner.post(`/crm/proposals/${p.id}/submit`).expect(200)).body;
    await owner.post(`/approvals/${sub.approvalRequestId}/decision`, { decision: 'approve' }).expect(200);
    const token = tokenOf((await owner.get(`/crm/proposals/${p.id}`).expect(200)).body.shareUrl);

    const anon = await client(app);
    await anon.get('/public/proposals/not-a-real-token-at-all-xxxx').expect(404);
    const view = (await anon.get(`/public/proposals/${token}`).expect(200)).body;
    expect(view).toMatchObject({ companyName: 'شركة أكمي للنقل', customerName: 'مصنع الدمام', total: 1380, status: 'sent' });
    expect(JSON.stringify(view)).not.toMatch(/buyer@factory|brainItemId|tenant|approval/);
    expect((await owner.get(`/crm/proposals/${p.id}`).expect(200)).body.viewedAt).not.toBeNull();

    await anon.post(`/public/proposals/${token}/decision`, { decision: 'accept' }).expect(400); // name required
    const acc = (await anon.post(`/public/proposals/${token}/decision`, { decision: 'accept', name: 'أحمد المشتري', note: 'موافقون' }).expect(200)).body;
    expect(acc).toMatchObject({ status: 'accepted', decisionByName: 'أحمد المشتري' });
    expect((await anon.post(`/public/proposals/${token}/decision`, { decision: 'decline', name: 'شخص آخر' }).expect(409)).body.error.code).toBe('ALREADY_DECIDED');
    const audit = await ownerQuery<{ action: string; actor_type: string }>("SELECT action, actor_type FROM audit_logs WHERE tenant_id = $1 AND action LIKE 'proposal.customer%'", [tenantId]);
    expect(audit).toEqual([{ action: 'proposal.customer_accept', actor_type: 'system' }]);

    // Revising makes a new draft and the old link stops working.
    await owner.post(`/crm/proposals/${p.id}/revise`).expect(409); // accepted proposals are final
  });

  it('revising a sent proposal invalidates its link; expired proposals cannot be accepted', async () => {
    const p = (await owner.post('/crm/proposals', { accountId, title: 'عرض', items: [{ brainItemId: price.id, quantity: 1 }] }).expect(201)).body;
    const sub = (await owner.post(`/crm/proposals/${p.id}/submit`).expect(200)).body;
    await owner.post(`/approvals/${sub.approvalRequestId}/decision`, { decision: 'approve' }).expect(200);
    const token = tokenOf((await owner.get(`/crm/proposals/${p.id}`).expect(200)).body.shareUrl);
    const anon = await client(app);
    await ownerQuery("UPDATE proposals SET valid_until = current_date - 1 WHERE id = $1", [p.id]);
    expect((await anon.post(`/public/proposals/${token}/decision`, { decision: 'accept', name: 'أحمد' }).expect(422)).body.error.code).toBe('PROPOSAL_EXPIRED');
    const rev = (await owner.post(`/crm/proposals/${p.id}/revise`).expect(200)).body;
    expect(rev).toMatchObject({ status: 'draft', shareUrl: null, version: p.version + 1 });
    await anon.get(`/public/proposals/${token}`).expect(404);
    expect((await owner.post(`/crm/proposals/${p.id}/submit`).expect(422)).body.error.code).toBe('PROPOSAL_EXPIRED');
  });

  it('respects record scope: a rep sees and edits only proposals of their own customers', async () => {
    const { client: rep } = await addMember(app, owner, 'rep@acme.sa', 'rep');
    const p = (await owner.post('/crm/proposals', { accountId, title: 'عرض', items: [] }).expect(201)).body;
    expect((await rep.get('/crm/proposals').expect(200)).body).toHaveLength(0);
    await rep.get(`/crm/proposals/${p.id}`).expect(404);
    await rep.post('/crm/proposals', { accountId, title: 'عرض' }).expect(404);
    const { client: ro } = await addMember(app, owner, 'ro@acme.sa', 'readonly');
    await ro.get(`/crm/proposals/${p.id}`).expect(200);
    await ro.post('/crm/proposals', { accountId, title: 'عرض' }).expect(403);
  });
});

describe('proposal agent', () => {
  it('drafts from the approved price list only; prices are set by the server, invented items are dropped', async () => {
    const d = (await owner.post('/crm/proposals/ai-draft', { accountId, contactId, request: 'يحتاجون 3 رحلات نقل مبرد وتخزين' }).expect(201)).body;
    expect(d).toMatchObject({ source: 'agent', status: 'draft', title: 'عرض نقل مبرد' });
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ unitPrice: 1200, quantity: 3, priceSource: 'price_list' });
    expect(d.unmatchedNeeds).toEqual(expect.arrayContaining(['تخزين مبرد', expect.stringContaining('مرجع غير موجود')]));
    expect(d.agentRunId).toBeTruthy();
  });

  it('refuses without an approved price list (before spending on the model)', async () => {
    await ownerQuery("UPDATE brain_items SET status = 'archived' WHERE section = 'pricing'");
    expect((await owner.post('/crm/proposals/ai-draft', { accountId, request: 'عرض نقل' }).expect(422)).body.error.code).toBe('NO_PRICE_LIST');
    expect(fake(app).calls).toHaveLength(0);
  });
});
