import type { INestApplication } from '@nestjs/common';
import { expect } from 'vitest';
import { fake, installDefaultAgents } from './ai-fake';
import type { CrmFixtures } from './crm-probes';
import { ownerQuery, type TestClient } from './helpers';

export interface AiFixtures {
  a: TestClient;
  b: TestClient;
  A: { accountId: string };
  B: {
    itemId: string; documentId: string; scoreId: string; runId: string; visitId: string; completedVisitId: string; accountId: string;
    contactId: string; draftId: string; approvalId: string; pendingDraftId: string;
  };
}

const SECRET = 'سر-الشركة-ب-التسعيري';
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const one = async (sql: string, p: unknown[]) => (await ownerQuery<Record<string, unknown>>(sql, p))[0];

export async function createAiFixtures(app: INestApplication, crm: CrmFixtures): Promise<AiFixtures> {
  installDefaultAgents(fake(app));
  const { a, b } = crm;
  const item = (await b.post('/brain/items', { section: 'products', title: 'منتج ب', body: SECRET }).expect(201)).body;
  await b.post(`/brain/items/${item.id}/approve`).expect(200);
  const doc = (await b.post('/brain/documents', { title: 'وثيقة ب', content: 'محتوى وثيقة الشركة ب الداخلية' }).expect(201)).body;
  const score = (await b.post(`/ai/accounts/${crm.B.accountId}/score`).expect(201)).body;
  await b.post(`/ai/visits/${crm.B.visitId}/brief`).expect(201);
  const v = (await b.post('/crm/visits', { accountId: crm.B.accountId, scheduledStart: inHours(1) }).expect(201)).body;
  await b.post(`/crm/visits/${v.id}/check-in`, { lat: 24.7, lng: 46.6, accuracyM: 10 }).expect(200);
  await b.post(`/crm/visits/${v.id}/complete`, { outcome: 'interested', nextStep: 'call', notes: 'العميل يحتاج نقل مبرد بين الرياض والدمام' }).expect(200);
  await b.post(`/ai/visits/${v.id}/insights`).expect(201);
  const contact = (await b.post(`/crm/accounts/${crm.B.accountId}/contacts`, { fullName: 'مشتري ب', email: 'buyer@b.sa' }).expect(201)).body;
  const draft = (await b.post(`/ai/accounts/${crm.B.accountId}/follow-up`, { contactId: contact.id, channel: 'email' }).expect(201)).body;
  const pending = (await b.post(`/ai/accounts/${crm.B.accountId}/follow-up`, { contactId: contact.id, channel: 'email' }).expect(201)).body;
  const sub = (await b.post(`/ai/drafts/${pending.id}/submit`).expect(200)).body;
  const runs = (await b.get('/ai/runs').expect(200)).body;
  return {
    a, b, A: crm.A,
    B: {
      itemId: item.id, documentId: doc.id, scoreId: score.id, runId: runs[0].id, visitId: crm.B.visitId, completedVisitId: v.id,
      accountId: crm.B.accountId, contactId: contact.id, draftId: draft.id, approvalId: sub.approvalRequestId, pendingDraftId: pending.id,
    },
  };
}

export function aiProbes(app: () => INestApplication, f: () => AiFixtures): Record<string, () => Promise<void>> {
  const notFound = async (res: Promise<{ status: number }> | { status: number }) => expect((await res).status).toBe(404);
  return {
    'GET /api/ai/status': async () => {
      await f().a.get('/ai/status').expect(200);
    },
    'GET /api/ai/settings': async () => {
      expect((await f().a.get('/ai/settings').expect(200)).body.usage.runsThisMonth).toBe(0); // B's runs are not counted
    },
    'PATCH /api/ai/settings': async () => {
      await f().a.patch('/ai/settings', { monthlyBudgetUsd: 1 }).expect(200);
      const b = (await f().b.get('/ai/settings').expect(200)).body;
      expect(b.monthlyBudgetUsd).toBe(20);
      await f().a.patch('/ai/settings', { monthlyBudgetUsd: 20 }).expect(200);
    },
    'PUT /api/ai/scoring': async () => {
      await f().a.put('/ai/scoring', { weights: { icp_fit: 100, need_size: 0, region_fit: 0, buying_power: 0, recurring_need: 0, data_quality: 0 } }).expect(200);
      expect((await f().b.get('/ai/settings').expect(200)).body.scoring.weights.icp_fit).toBe(30);
    },
    'GET /api/ai/runs': async () => {
      const s = JSON.stringify((await f().a.get(`/ai/runs?entityId=${f().B.accountId}`).expect(200)).body);
      expect(s).toBe('[]');
    },
    'GET /api/ai/runs/:id': async () => notFound(f().a.get(`/ai/runs/${f().B.runId}`)),
    'POST /api/ai/accounts/:id/score': async () => {
      await notFound(f().a.post(`/ai/accounts/${f().B.accountId}/score`));
      // A's own run must never see B's Sales Brain.
      await f().a.post(`/ai/accounts/${f().A.accountId}/score`).expect(201);
      expect(fake(app()).calls.at(-1)!.prompt).not.toContain(SECRET);
    },
    'GET /api/ai/accounts/:id/scores': async () => notFound(f().a.get(`/ai/accounts/${f().B.accountId}/scores`)),
    'POST /api/ai/scores/:id/review': async () => {
      await notFound(f().a.post(`/ai/scores/${f().B.scoreId}/review`, { decision: 'override', tier: 'D' }));
      expect((await one('SELECT review_status FROM lead_scores WHERE id=$1', [f().B.scoreId]))!.review_status).toBe('unreviewed');
    },
    'POST /api/ai/visits/:id/brief': async () => notFound(f().a.post(`/ai/visits/${f().B.visitId}/brief`)),
    'GET /api/ai/visits/:id/brief': async () => notFound(f().a.get(`/ai/visits/${f().B.visitId}/brief`)),
    'POST /api/ai/visits/:id/insights': async () => notFound(f().a.post(`/ai/visits/${f().B.completedVisitId}/insights`)),
    'GET /api/ai/visits/:id/insights': async () => notFound(f().a.get(`/ai/visits/${f().B.completedVisitId}/insights`)),
    'POST /api/ai/accounts/:id/follow-up': async () => {
      await notFound(f().a.post(`/ai/accounts/${f().B.accountId}/follow-up`, { contactId: f().B.contactId, channel: 'email' }));
      // B's contact on A's own account: also not found.
      await notFound(f().a.post(`/ai/accounts/${f().A.accountId}/follow-up`, { contactId: f().B.contactId, channel: 'email' }));
    },
    'GET /api/ai/accounts/:id/drafts': async () => notFound(f().a.get(`/ai/accounts/${f().B.accountId}/drafts`)),
    'PATCH /api/ai/drafts/:id': async () => {
      await notFound(f().a.patch(`/ai/drafts/${f().B.draftId}`, { body: 'hijacked text' }));
      expect((await one('SELECT body FROM message_drafts WHERE id=$1', [f().B.draftId]))!.body).not.toBe('hijacked text');
    },
    'POST /api/ai/drafts/:id/submit': async () => {
      await notFound(f().a.post(`/ai/drafts/${f().B.draftId}/submit`));
      expect((await one('SELECT status FROM message_drafts WHERE id=$1', [f().B.draftId]))!.status).toBe('draft');
    },
    'GET /api/brain': async () => {
      const s = JSON.stringify((await f().a.get('/brain').expect(200)).body);
      expect(s).not.toContain(SECRET);
      expect(s).not.toContain(f().B.documentId);
    },
    'POST /api/brain/items': async () => {
      const it = (await f().a.post('/brain/items', { section: 'faq', title: 'سؤال أ' }).expect(201)).body;
      expect((await one('SELECT tenant_id FROM brain_items WHERE id=$1', [it.id]))!.tenant_id).not.toBe((await one('SELECT tenant_id FROM brain_items WHERE id=$1', [f().B.itemId]))!.tenant_id);
    },
    'PATCH /api/brain/items/:id': async () => {
      await notFound(f().a.patch(`/brain/items/${f().B.itemId}`, { body: 'hacked' }));
      expect((await one('SELECT body FROM brain_items WHERE id=$1', [f().B.itemId]))!.body).toBe(SECRET);
    },
    'POST /api/brain/items/:id/approve': async () => notFound(f().a.post(`/brain/items/${f().B.itemId}/approve`)),
    'POST /api/brain/items/:id/archive': async () => {
      await notFound(f().a.post(`/brain/items/${f().B.itemId}/archive`));
      expect((await one('SELECT status FROM brain_items WHERE id=$1', [f().B.itemId]))!.status).toBe('approved');
    },
    'GET /api/brain/items/:id/versions': async () => notFound(f().a.get(`/brain/items/${f().B.itemId}/versions`)),
    'POST /api/brain/documents': async () => {
      await f().a.post('/brain/documents', { title: 'وثيقة أ', content: 'محتوى خاص بالشركة أ فقط' }).expect(201);
    },
    'POST /api/brain/documents/:id/approve': async () => {
      await notFound(f().a.post(`/brain/documents/${f().B.documentId}/approve`));
      expect((await one('SELECT trust_level FROM brain_documents WHERE id=$1', [f().B.documentId]))!.trust_level).toBe('unverified');
    },
    'DELETE /api/brain/documents/:id': async () => {
      await notFound(f().a.delete(`/brain/documents/${f().B.documentId}`));
      expect(await ownerQuery('SELECT 1 FROM brain_documents WHERE id=$1', [f().B.documentId])).toHaveLength(1);
    },
    'GET /api/approvals': async () => {
      expect(JSON.stringify((await f().a.get('/approvals').expect(200)).body)).not.toContain(f().B.approvalId);
    },
    'GET /api/approvals/:id': async () => notFound(f().a.get(`/approvals/${f().B.approvalId}`)),
    'POST /api/approvals/:id/decision': async () => {
      await notFound(f().a.post(`/approvals/${f().B.approvalId}/decision`, { decision: 'approve' }));
      expect((await one('SELECT status FROM approval_requests WHERE id=$1', [f().B.approvalId]))!.status).toBe('pending');
    },
  };
}
