import { expect } from 'vitest';
import { ownerQuery, type TestClient } from './helpers';

/** Company B's CRM fixtures, created once in the isolation suite. */
export interface CrmFixtures {
  a: TestClient;
  b: TestClient;
  B: {
    trackId: string; reasonId: string; customFieldId: string; pipelineId: string; stageWonId: string; accountId: string; contactId: string;
    noteId: string; opportunityId: string; taskId: string; visitId: string; importId: string; importRowId: number;
  };
  A: { importId: string; accountId: string };
}

const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

export async function createCrmFixtures(a: TestClient, b: TestClient): Promise<CrmFixtures> {
  const s1 = (await b.post('/crm/tracks', { key: 'b_track', name: 'مسار ب' }).expect(201)).body;
  const s2 = (await b.post('/crm/reasons', { kind: 'loss', label: 'سبب خاص بالشركة ب' }).expect(201)).body;
  const s3 = (await b.post('/crm/custom-fields', { entity: 'account', key: 'b_field', label: 'حقل ب', type: 'text' }).expect(201)).body;
  const pipeline = s1.pipelines.find((p: { isDefault: boolean }) => p.isDefault);
  const account = (await b.post('/crm/accounts', { name: 'عميل الشركة ب', crNumber: '2020202020', city: 'الرياض' }).expect(201)).body;
  const contact = (await b.post(`/crm/accounts/${account.id}/contacts`, { fullName: 'جهة ب', phone: '0509998888' }).expect(201)).body;
  const note = (await b.post(`/crm/accounts/${account.id}/notes`, { body: 'ملاحظة سرية للشركة ب' }).expect(201)).body;
  const opp = (await b.post('/crm/opportunities', { accountId: account.id, title: 'صفقة ب', amount: 999 }).expect(201)).body;
  const task = (await b.post('/crm/tasks', { title: 'مهمة ب', accountId: account.id, dueAt: inDays(1) }).expect(201)).body;
  const visit = (await b.post('/crm/visits', { accountId: account.id, opportunityId: opp.id, scheduledStart: inDays(1) }).expect(201)).body;
  const job = (await b.upload('/crm/imports', Buffer.from('اسم الشركة\nمستورد ب'), 'b.csv').expect(201)).body;
  await b.put(`/crm/imports/${job.id}/mapping`, { mapping: job.suggestedMapping, dataPermissionConfirmed: true }).expect(200);
  const rows = (await b.get(`/crm/imports/${job.id}/rows`).expect(200)).body.items;
  const aJob = (await a.upload('/crm/imports', Buffer.from('اسم الشركة\nمستورد أ'), 'a.csv').expect(201)).body;
  await a.put(`/crm/imports/${aJob.id}/mapping`, { mapping: aJob.suggestedMapping, dataPermissionConfirmed: true }).expect(200);
  const aAccount = (await a.post('/crm/accounts', { name: 'عميل الشركة أ' }).expect(201)).body;
  return {
    a, b,
    B: {
      trackId: s1.tracks[0].id, reasonId: s2.reasons.find((r: { label: string }) => r.label === 'سبب خاص بالشركة ب').id,
      customFieldId: s3.customFields[0].id, pipelineId: pipeline.id, stageWonId: pipeline.stages.find((x: { key: string }) => x.key === 'won').id,
      accountId: account.id, contactId: contact.id, noteId: note.id, opportunityId: opp.id, taskId: task.id, visitId: visit.id,
      importId: job.id, importRowId: rows[0].id,
    },
    A: { importId: aJob.id, accountId: aAccount.id },
  };
}

const one = async (sql: string, p: unknown[]) => (await ownerQuery<Record<string, unknown>>(sql, p))[0];

/** Each probe: A attacks B's resources; expect "not found" and B's data unchanged. */
export function crmProbes(f: () => CrmFixtures): Record<string, () => Promise<void>> {
  return {
    'GET /api/crm/settings': async () => {
      const s = JSON.stringify((await f().a.get('/crm/settings').expect(200)).body);
      for (const id of [f().B.trackId, f().B.reasonId, f().B.customFieldId, f().B.pipelineId]) expect(s).not.toContain(id);
    },
    'POST /api/crm/tracks': async () => {
      await f().a.post('/crm/tracks', { key: 'b_track', name: 'مسار ب' }).expect(201); // same key in another company is fine
    },
    'PATCH /api/crm/tracks/:id': async () => {
      await f().a.patch(`/crm/tracks/${f().B.trackId}`, { key: 'b_track', name: 'hacked' }).expect(404);
      expect((await one('SELECT name FROM tracks WHERE id = $1', [f().B.trackId]))!.name).toBe('مسار ب');
    },
    'PUT /api/crm/pipelines/:id': async () => {
      const stages = [{ key: 'won_x', name: 'w', category: 'won' }, { key: 'lost_x', name: 'l', category: 'lost' }];
      await f().a.put(`/crm/pipelines/${f().B.pipelineId}`, { name: 'hacked', stages }).expect(404);
      expect((await one('SELECT count(*)::int AS n FROM pipeline_stages WHERE pipeline_id = $1', [f().B.pipelineId]))!.n).toBe(11);
    },
    'POST /api/crm/reasons': async () => {
      await f().a.post('/crm/reasons', { kind: 'loss', label: 'سبب خاص بالشركة ب' }).expect(201);
    },
    'PATCH /api/crm/reasons/:id': async () => {
      await f().a.patch(`/crm/reasons/${f().B.reasonId}`, { isActive: false }).expect(404);
      expect((await one('SELECT is_active FROM outcome_reasons WHERE id = $1', [f().B.reasonId]))!.is_active).toBe(true);
    },
    'POST /api/crm/custom-fields': async () => {
      // A track id from B cannot be referenced (composite FK).
      const r = await f().a.post('/crm/custom-fields', { entity: 'account', key: 'x_field', label: 'x', type: 'text', trackId: f().B.trackId });
      expect(r.status).toBe(404);
    },
    'DELETE /api/crm/custom-fields/:id': async () => {
      await f().a.delete(`/crm/custom-fields/${f().B.customFieldId}`).expect(404);
      expect(await one('SELECT 1 AS x FROM custom_field_defs WHERE id = $1', [f().B.customFieldId])).toBeDefined();
    },
    'GET /api/crm/accounts': async () => {
      const r = (await f().a.get(`/crm/accounts?q=${encodeURIComponent('2020202020')}`).expect(200)).body;
      expect(r.total).toBe(0);
      expect(JSON.stringify((await f().a.get('/crm/accounts?pageSize=100').expect(200)).body)).not.toContain(f().B.accountId);
    },
    'GET /api/crm/accounts/export': async () => {
      const r = await f().a.get('/crm/accounts/export?format=csv').expect(200);
      expect(r.text).not.toContain('عميل الشركة ب');
    },
    'POST /api/crm/accounts': async () => {
      // Duplicate detection must not see B's accounts (same CR is allowed across companies).
      await f().a.post('/crm/accounts', { name: 'عميل الشركة ب', crNumber: '2020202020', city: 'الرياض' }).expect(201);
      // Cannot attach B's track.
      expect((await f().a.post('/crm/accounts', { name: 'x y', trackId: f().B.trackId })).body.error.code).toBe('INVALID_REFERENCE');
    },
    'GET /api/crm/accounts/:id': async () => {
      await f().a.get(`/crm/accounts/${f().B.accountId}`).expect(404);
    },
    'PATCH /api/crm/accounts/:id': async () => {
      await f().a.patch(`/crm/accounts/${f().B.accountId}`, { name: 'hacked' }).expect(404);
      expect((await one('SELECT name FROM accounts WHERE id = $1', [f().B.accountId]))!.name).toBe('عميل الشركة ب');
    },
    'DELETE /api/crm/accounts/:id': async () => {
      await f().a.delete(`/crm/accounts/${f().B.accountId}`).expect(404);
      expect((await one('SELECT deleted_at FROM accounts WHERE id = $1', [f().B.accountId]))!.deleted_at).toBeNull();
    },
    'GET /api/crm/accounts/:id/contacts': async () => {
      await f().a.get(`/crm/accounts/${f().B.accountId}/contacts`).expect(404);
    },
    'POST /api/crm/accounts/:id/contacts': async () => {
      await f().a.post(`/crm/accounts/${f().B.accountId}/contacts`, { fullName: 'دخيل' }).expect(404);
      expect((await one("SELECT count(*)::int AS n FROM contacts WHERE account_id = $1 AND full_name = 'دخيل'", [f().B.accountId]))!.n).toBe(0);
    },
    'PATCH /api/crm/contacts/:id': async () => {
      await f().a.patch(`/crm/contacts/${f().B.contactId}`, { fullName: 'hacked' }).expect(404);
      expect((await one('SELECT full_name FROM contacts WHERE id = $1', [f().B.contactId]))!.full_name).toBe('جهة ب');
    },
    'PUT /api/crm/contacts/:id/dnc': async () => {
      await f().a.put(`/crm/contacts/${f().B.contactId}/dnc`, { doNotContact: true }).expect(404);
      expect((await one('SELECT do_not_contact FROM contacts WHERE id = $1', [f().B.contactId]))!.do_not_contact).toBe(false);
    },
    'DELETE /api/crm/contacts/:id': async () => {
      await f().a.delete(`/crm/contacts/${f().B.contactId}`).expect(404);
      expect((await one('SELECT deleted_at FROM contacts WHERE id = $1', [f().B.contactId]))!.deleted_at).toBeNull();
    },
    'GET /api/crm/accounts/:id/notes': async () => {
      await f().a.get(`/crm/accounts/${f().B.accountId}/notes`).expect(404);
    },
    'POST /api/crm/accounts/:id/notes': async () => {
      await f().a.post(`/crm/accounts/${f().B.accountId}/notes`, { body: 'x' }).expect(404);
    },
    'DELETE /api/crm/notes/:id': async () => {
      await f().a.delete(`/crm/notes/${f().B.noteId}`).expect(404);
      expect((await one('SELECT deleted_at FROM notes WHERE id = $1', [f().B.noteId]))!.deleted_at).toBeNull();
    },
    'GET /api/crm/accounts/:id/timeline': async () => {
      await f().a.get(`/crm/accounts/${f().B.accountId}/timeline`).expect(404);
    },
    'GET /api/crm/opportunities': async () => {
      expect(JSON.stringify((await f().a.get('/crm/opportunities').expect(200)).body)).not.toContain(f().B.opportunityId);
    },
    'POST /api/crm/opportunities': async () => {
      await f().a.post('/crm/opportunities', { accountId: f().B.accountId, title: 'x y' }).expect(404);
      // Own account but B's pipeline.
      const r = await f().a.post('/crm/opportunities', { accountId: f().A.accountId, title: 'x y', pipelineId: f().B.pipelineId });
      expect(r.status).toBe(400);
    },
    'GET /api/crm/opportunities/:id': async () => {
      await f().a.get(`/crm/opportunities/${f().B.opportunityId}`).expect(404);
    },
    'PATCH /api/crm/opportunities/:id': async () => {
      await f().a.patch(`/crm/opportunities/${f().B.opportunityId}`, { amount: 1 }).expect(404);
      expect(Number((await one('SELECT amount FROM opportunities WHERE id = $1', [f().B.opportunityId]))!.amount)).toBe(999);
    },
    'POST /api/crm/opportunities/:id/stage': async () => {
      await f().a.post(`/crm/opportunities/${f().B.opportunityId}/stage`, { stageId: f().B.stageWonId, outcomeReasonId: f().B.reasonId }).expect(404);
      // A cannot move its own deal into B's stage either.
      const own = (await f().a.post('/crm/opportunities', { accountId: f().A.accountId, title: 'own' }).expect(201)).body;
      expect((await f().a.post(`/crm/opportunities/${own.id}/stage`, { stageId: f().B.stageWonId })).status).toBe(400);
    },
    'DELETE /api/crm/opportunities/:id': async () => {
      await f().a.delete(`/crm/opportunities/${f().B.opportunityId}`).expect(404);
      expect((await one('SELECT deleted_at FROM opportunities WHERE id = $1', [f().B.opportunityId]))!.deleted_at).toBeNull();
    },
    'GET /api/crm/tasks': async () => {
      const r = (await f().a.get('/crm/tasks?view=all').expect(200)).body;
      expect(JSON.stringify(r)).not.toContain(f().B.taskId);
      await f().a.get(`/crm/tasks?accountId=${f().B.accountId}`).expect(404);
    },
    'POST /api/crm/tasks': async () => {
      await f().a.post('/crm/tasks', { title: 'x y', accountId: f().B.accountId }).expect(404);
      await f().a.post('/crm/tasks', { title: 'x y', opportunityId: f().B.opportunityId }).expect(404);
    },
    'PATCH /api/crm/tasks/:id': async () => {
      await f().a.patch(`/crm/tasks/${f().B.taskId}`, { status: 'done' }).expect(404);
      expect((await one('SELECT status FROM tasks WHERE id = $1', [f().B.taskId]))!.status).toBe('open');
    },
    'GET /api/crm/visits': async () => {
      const r = (await f().a.get(`/crm/visits?from=${inDays(-1)}&to=${inDays(7)}`).expect(200)).body;
      expect(JSON.stringify(r)).not.toContain(f().B.visitId);
      await f().a.get(`/crm/visits?from=${inDays(-1)}&to=${inDays(7)}&accountId=${f().B.accountId}`).expect(404);
    },
    'POST /api/crm/visits': async () => {
      await f().a.post('/crm/visits', { accountId: f().B.accountId, scheduledStart: inDays(1) }).expect(404);
      await f().a.post('/crm/visits', { accountId: f().A.accountId, opportunityId: f().B.opportunityId, scheduledStart: inDays(1) }).expect(404);
    },
    'GET /api/crm/visits/:id': async () => {
      await f().a.get(`/crm/visits/${f().B.visitId}`).expect(404);
    },
    'PATCH /api/crm/visits/:id': async () => {
      await f().a.patch(`/crm/visits/${f().B.visitId}`, { scheduledStart: inDays(5) }).expect(404);
    },
    'POST /api/crm/visits/:id/check-in': async () => {
      await f().a.post(`/crm/visits/${f().B.visitId}/check-in`, {}).expect(404);
    },
    'POST /api/crm/visits/:id/complete': async () => {
      await f().a.post(`/crm/visits/${f().B.visitId}/complete`, { outcome: 'interested', nextStep: 'none' }).expect(404);
    },
    'POST /api/crm/visits/:id/cancel': async () => {
      await f().a.post(`/crm/visits/${f().B.visitId}/cancel`).expect(404);
      expect((await one('SELECT status FROM visits WHERE id = $1', [f().B.visitId]))!.status).toBe('scheduled');
    },
    'POST /api/crm/imports': async () => {
      // Upload always lands in the caller's company.
      const j = (await f().a.upload('/crm/imports', Buffer.from('name\nx y'), 'x.csv').expect(201)).body;
      expect((await one('SELECT tenant_id FROM import_jobs WHERE id = $1', [j.id]))!.tenant_id).not.toBe(
        (await one('SELECT tenant_id FROM import_jobs WHERE id = $1', [f().B.importId]))!.tenant_id,
      );
    },
    'GET /api/crm/imports/:id': async () => {
      await f().a.get(`/crm/imports/${f().B.importId}`).expect(404);
    },
    'PUT /api/crm/imports/:id/mapping': async () => {
      await f().a.put(`/crm/imports/${f().B.importId}/mapping`, { mapping: { name: 'اسم الشركة' }, dataPermissionConfirmed: true }).expect(404);
    },
    'GET /api/crm/imports/:id/rows': async () => {
      await f().a.get(`/crm/imports/${f().B.importId}/rows`).expect(404);
    },
    'PATCH /api/crm/imports/:id/rows/:rowId': async () => {
      await f().a.patch(`/crm/imports/${f().B.importId}/rows/${f().B.importRowId}`, { resolution: 'skip' }).expect(404);
      // A's own job id with B's row id.
      await f().a.patch(`/crm/imports/${f().A.importId}/rows/${f().B.importRowId}`, { resolution: 'skip' }).expect(404);
      expect((await one('SELECT resolution FROM import_rows WHERE id = $1', [f().B.importRowId]))!.resolution).toBe('create');
    },
    'POST /api/crm/imports/:id/execute': async () => {
      await f().a.post(`/crm/imports/${f().B.importId}/execute`).expect(404);
      expect((await one('SELECT status FROM import_jobs WHERE id = $1', [f().B.importId]))!.status).toBe('review');
    },
    'POST /api/crm/imports/:id/cancel': async () => {
      await f().a.post(`/crm/imports/${f().B.importId}/cancel`).expect(404);
      expect((await one('SELECT status FROM import_jobs WHERE id = $1', [f().B.importId]))!.status).toBe('review');
    },
    'GET /api/reports/dashboard': async () => {
      const d = (await f().a.get(`/reports/dashboard?from=${inDays(-1)}&to=${inDays(1)}`).expect(200)).body;
      const b = (await f().b.get(`/reports/dashboard?from=${inDays(-1)}&to=${inDays(1)}`).expect(200)).body;
      expect(d.totals.pipelineValue).not.toBe(999);
      expect(d.stageFunnel.some((r: { value: number }) => r.value === 999)).toBe(false);
      expect(b.totals.pipelineValue).toBe(999);
      expect(d.byRep.map((r: { name: string }) => r.name)).not.toContain('Owner Company B');
      // A's dashboard filtered by B's track sees nothing of B.
      const t = (await f().a.get(`/reports/dashboard?from=${inDays(-1)}&to=${inDays(1)}&trackId=${f().B.trackId}`).expect(200)).body;
      expect(t.totals.accounts).toBe(0);
    },
  };
}
