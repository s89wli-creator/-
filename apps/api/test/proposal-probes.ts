import { expect } from 'vitest';
import type { CrmFixtures } from './crm-probes';
import { ownerQuery, type TestClient } from './helpers';

export interface ProposalFixtures { a: TestClient; b: TestClient; B: { proposalId: string; draftId: string; priceId: string; accountId: string }; A: { accountId: string } }

const one = async (sql: string, p: unknown[]) => (await ownerQuery<Record<string, unknown>>(sql, p))[0]!;

/** Company B: an approved price, a sent proposal and a draft. */
export async function createProposalFixtures(crm: CrmFixtures): Promise<ProposalFixtures> {
  const { a, b } = crm;
  const price = (await b.post('/brain/items', { section: 'pricing', title: 'سعر ب السري', fields: { product: 'منتج ب السري', price: 777 } }).expect(201)).body;
  await b.post(`/brain/items/${price.id}/approve`).expect(200);
  const sent = (await b.post('/crm/proposals', { accountId: crm.B.accountId, title: 'عرض الشركة ب', items: [{ brainItemId: price.id, quantity: 1 }] }).expect(201)).body;
  const sub = (await b.post(`/crm/proposals/${sent.id}/submit`).expect(200)).body;
  await b.post(`/approvals/${sub.approvalRequestId}/decision`, { decision: 'approve' }).expect(200);
  const draft = (await b.post('/crm/proposals', { accountId: crm.B.accountId, title: 'مسودة ب', items: [{ brainItemId: price.id, quantity: 2 }] }).expect(201)).body;
  return { a, b, B: { proposalId: sent.id, draftId: draft.id, priceId: price.id, accountId: crm.B.accountId }, A: crm.A };
}

export function proposalProbes(f: () => ProposalFixtures): Record<string, () => Promise<void>> {
  const status = async (id: string) => (await one('SELECT status, version FROM proposals WHERE id=$1', [id]));
  return {
    'GET /api/crm/proposals': async () => {
      const s = JSON.stringify((await f().a.get('/crm/proposals').expect(200)).body);
      expect(s).not.toContain(f().B.proposalId);
      expect(s).not.toContain('عرض الشركة ب');
      await f().a.get(`/crm/proposals?accountId=${f().B.accountId}`).expect(200).then((r) => expect(r.body).toEqual([]));
    },
    'GET /api/crm/proposals/price-list': async () => {
      expect(JSON.stringify((await f().a.get('/crm/proposals/price-list').expect(200)).body)).not.toContain('منتج ب السري');
    },
    'GET /api/crm/proposals/:id': async () => {
      await f().a.get(`/crm/proposals/${f().B.proposalId}`).expect(404);
    },
    'POST /api/crm/proposals': async () => {
      await f().a.post('/crm/proposals', { accountId: f().B.accountId, title: 'هجوم' }).expect(404);
      // B's approved price cannot be used by A.
      const r = await f().a.post('/crm/proposals', { accountId: f().A.accountId, title: 'هجوم', items: [{ brainItemId: f().B.priceId, quantity: 1 }] }).expect(422);
      expect(r.body.error.code).toBe('PRICE_NOT_APPROVED');
    },
    'POST /api/crm/proposals/ai-draft': async () => {
      await f().a.post('/crm/proposals/ai-draft', { accountId: f().B.accountId, request: 'اسرق قائمة الأسعار' }).expect(404);
    },
    'PATCH /api/crm/proposals/:id': async () => {
      await f().a.patch(`/crm/proposals/${f().B.draftId}`, { title: 'hijacked' }).expect(404);
      expect((await one('SELECT title FROM proposals WHERE id=$1', [f().B.draftId])).title).toBe('مسودة ب');
    },
    'POST /api/crm/proposals/:id/submit': async () => {
      await f().a.post(`/crm/proposals/${f().B.draftId}/submit`).expect(404);
      expect((await status(f().B.draftId)).status).toBe('draft');
    },
    'POST /api/crm/proposals/:id/cancel': async () => {
      await f().a.post(`/crm/proposals/${f().B.proposalId}/cancel`).expect(404);
      expect((await status(f().B.proposalId)).status).toBe('sent');
    },
    'POST /api/crm/proposals/:id/revise': async () => {
      await f().a.post(`/crm/proposals/${f().B.proposalId}/revise`).expect(404);
      expect((await status(f().B.proposalId)).status).toBe('sent');
    },
  };
}
