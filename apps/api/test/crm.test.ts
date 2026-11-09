import type { INestApplication } from '@nestjs/common';
import type { CrmSettingsDto, PipelineDto } from '@rakan/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, ownerQuery, registerCompany, resetDb, startApp, type TestClient } from './helpers';

let app: INestApplication;
let owner: TestClient;
let rep: TestClient;
let repId: string;
let settings: CrmSettingsDto;
let pipeline: PipelineDto;
const stage = (key: string) => pipeline.stages.find((s) => s.key === key)!;
const reason = (kind: string) => settings.reasons.find((r) => r.kind === kind)!;
const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  ({ client: owner } = await registerCompany(app, { email: 'owner@acme.sa', company: 'Acme' }));
  ({ client: rep, membershipId: repId } = await addMember(app, owner, 'rep@acme.sa', 'rep'));
  settings = (await owner.get('/crm/settings').expect(200)).body;
  pipeline = settings.pipelines.find((p) => p.isDefault)!;
});

describe('CRM settings', () => {
  it('new companies get the default pipeline (11 stages) and reasons', () => {
    expect(pipeline.stages.map((s) => s.key)).toEqual([
      'new', 'analyzed', 'qualified', 'contacted', 'visit_scheduled', 'visit_done', 'proposal_sent', 'negotiation', 'won', 'lost', 'postponed',
    ]);
    expect(settings.reasons.filter((r) => r.kind === 'loss').length).toBeGreaterThan(3);
  });

  it('a track gets its own pipeline; accounts on that track use it', async () => {
    const s = (await owner.post('/crm/tracks', { key: 'carrier', name: 'شركات النقل' }).expect(201)).body as CrmSettingsDto;
    const track = s.tracks.find((t) => t.key === 'carrier')!;
    const p = s.pipelines.find((x) => x.trackId === track.id)!;
    expect(p.stages).toHaveLength(11);
    const acc = (await owner.post('/crm/accounts', { name: 'ناقل الخليج', trackId: track.id }).expect(201)).body;
    const opp = (await owner.post('/crm/opportunities', { accountId: acc.id, title: 'تسجيل في المنصة' }).expect(201)).body;
    expect(opp.pipelineId).toBe(p.id);
    expect((await owner.post('/crm/tracks', { key: 'carrier', name: 'x y' })).body.error.code).toBe('NAME_TAKEN');
  });

  it('pipeline edit: rename/add stages; a stage in use cannot be removed', async () => {
    const acc = (await owner.post('/crm/accounts', { name: 'مصنع الشرق' }).expect(201)).body;
    await owner.post('/crm/opportunities', { accountId: acc.id, title: 'صفقة' }).expect(201); // sits in "new"
    const stages = pipeline.stages.map((s) => ({ id: s.id, key: s.key, name: s.name, category: s.category }));
    const renamed = stages.map((s) => (s.key === 'contacted' ? { ...s, name: 'تم الاتصال' } : s));
    renamed.splice(7, 0, { key: 'trial', name: 'تجربة', category: 'open' } as (typeof stages)[number]);
    const res = (await owner.put(`/crm/pipelines/${pipeline.id}`, { name: pipeline.name, stages: renamed }).expect(200)).body as CrmSettingsDto;
    const p = res.pipelines.find((x) => x.id === pipeline.id)!;
    expect(p.stages.map((s) => s.key)).toContain('trial');
    expect(p.stages.find((s) => s.key === 'contacted')!.name).toBe('تم الاتصال');
    const withoutNew = renamed.filter((s) => s.key !== 'new');
    expect((await owner.put(`/crm/pipelines/${pipeline.id}`, { name: 'x y', stages: withoutNew })).body.error.code).toBe('STAGE_IN_USE');
    expect((await owner.put(`/crm/pipelines/${pipeline.id}`, { name: 'x y', stages: renamed.filter((s) => s.category !== 'won') })).status).toBe(400);
  });

  it('custom fields are validated on accounts', async () => {
    await owner.post('/crm/custom-fields', { entity: 'account', key: 'fleet_size', label: 'حجم الأسطول', type: 'number' }).expect(201);
    await owner.post('/crm/custom-fields', { entity: 'account', key: 'cargo', label: 'نوع الشحنات', type: 'select', options: ['مبرد', 'جاف'] }).expect(201);
    const ok = await owner.post('/crm/accounts', { name: 'ناقل', customFields: { fleet_size: '1,200', cargo: 'مبرد' } }).expect(201);
    expect(ok.body.customFields).toEqual({ fleet_size: 1200, cargo: 'مبرد' });
    const bad = await owner.post('/crm/accounts', { name: 'ناقل 2', customFields: { cargo: 'سائل', unknown: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['customFields.cargo', 'customFields.unknown']);
  });

  it('only owner/manager can change CRM settings', async () => {
    expect((await rep.post('/crm/tracks', { key: 'x1', name: 'x y' })).status).toBe(403);
  });
});

describe('accounts', () => {
  it('normalizes identifiers and detects duplicates by CR and by name+city', async () => {
    const a = (await owner.post('/crm/accounts', { name: 'شركة النقل السريع المحدودة', crNumber: '1010123456', phone: '0112345678', website: 'https://www.fast.sa/x', city: 'الرياض' }).expect(201)).body;
    expect(a).toMatchObject({ phone: '+966112345678', websiteDomain: 'fast.sa' });

    const byCr = await owner.post('/crm/accounts', { name: 'اسم آخر', crNumber: '1010123456' });
    expect(byCr.status).toBe(409);
    expect(byCr.body.error).toMatchObject({ code: 'DUPLICATE_ACCOUNT', details: { id: a.id, reason: 'cr_number' } });

    const byName = await owner.post('/crm/accounts', { name: 'مؤسسة النقل السريع', city: 'الرياض' });
    expect(byName.body.error.details.reason).toBe('name_city');
    // Same name in a different city is a different branch/company.
    await owner.post('/crm/accounts', { name: 'مؤسسة النقل السريع', city: 'جدة' }).expect(201);
    // Explicit override is allowed and audited.
    await owner.post('/crm/accounts', { name: 'مؤسسة النقل السريع', city: 'الرياض', force: true }).expect(201);
    const [log] = await ownerQuery<{ after: { forcedDespiteDuplicate?: boolean } }>(`SELECT after FROM audit_logs WHERE action = 'account.create' ORDER BY id DESC LIMIT 1`);
    expect(log!.after.forcedDespiteDuplicate).toBe(true);
  });

  it('Arabic-insensitive search, filters and pagination', async () => {
    for (const n of ['مصنع الإنجاز للأغذية', 'مستودعات الأمانة', 'شركة البناء']) await owner.post('/crm/accounts', { name: n, city: 'الرياض' }).expect(201);
    const s = (await owner.get(`/crm/accounts?q=${encodeURIComponent('الانجاز')}`).expect(200)).body;
    expect(s.items.map((i: { name: string }) => i.name)).toEqual(['مصنع الإنجاز للأغذية']);
    const p = (await owner.get('/crm/accounts?pageSize=2&page=2&sort=name').expect(200)).body;
    expect(p.total).toBe(3);
    expect(p.items).toHaveLength(1);
  });

  it('reps see and edit only their own accounts; cannot reassign, delete, import or export', async () => {
    const mine = (await rep.post('/crm/accounts', { name: 'عميل المندوب' }).expect(201)).body;
    expect(mine.ownerMembershipId).toBe(repId);
    const other = (await owner.post('/crm/accounts', { name: 'عميل الإدارة' }).expect(201)).body;

    const list = (await rep.get('/crm/accounts').expect(200)).body;
    expect(list.items.map((i: { id: string }) => i.id)).toEqual([mine.id]);
    await rep.get(`/crm/accounts/${other.id}`).expect(404);
    await rep.patch(`/crm/accounts/${other.id}`, { city: 'جدة' }).expect(404);
    expect((await rep.patch(`/crm/accounts/${mine.id}`, { ownerMembershipId: null })).status).toBe(403);
    await rep.delete(`/crm/accounts/${mine.id}`).expect(403);
    await rep.get('/crm/accounts/export').expect(403);
    await rep.upload('/crm/imports', Buffer.from('name\nx y'), 'a.csv').expect(403);

    // Company setting "reps can see all customers": read yes, write still no.
    await owner.patch('/tenant', { settings: { repVisibility: 'all' } }).expect(200);
    await rep.get(`/crm/accounts/${other.id}`).expect(200);
    expect((await rep.patch(`/crm/accounts/${other.id}`, { city: 'جدة' })).status).toBe(403);

    // Assigning the account makes it the rep's.
    await owner.patch(`/crm/accounts/${other.id}`, { ownerMembershipId: repId }).expect(200);
    await rep.patch(`/crm/accounts/${other.id}`, { city: 'جدة' }).expect(200);
  });

  it('soft delete hides the account everywhere', async () => {
    const a = (await owner.post('/crm/accounts', { name: 'للحذف' }).expect(201)).body;
    await owner.delete(`/crm/accounts/${a.id}`).expect(204);
    await owner.get(`/crm/accounts/${a.id}`).expect(404);
    expect((await owner.get('/crm/accounts').expect(200)).body.total).toBe(0);
    expect(await ownerQuery('SELECT 1 FROM accounts WHERE id = $1 AND deleted_at IS NOT NULL', [a.id])).toHaveLength(1);
  });
});

describe('contacts (personal data)', () => {
  it('stores phone/email encrypted, returns them decrypted, supports do-not-contact and erasure', async () => {
    const a = (await owner.post('/crm/accounts', { name: 'مصنع' }).expect(201)).body;
    const c = (await owner.post(`/crm/accounts/${a.id}/contacts`, { fullName: 'خالد', phone: '0501234567', email: 'K@X.SA', isPrimary: true }).expect(201)).body;
    expect(c).toMatchObject({ phone: '+966501234567', email: 'k@x.sa', isPrimary: true });
    const [row] = await ownerQuery<{ phone_enc: string; email_enc: string }>('SELECT phone_enc, email_enc FROM contacts WHERE id = $1', [c.id]);
    expect(row!.phone_enc).not.toContain('501234567');
    expect(row!.email_enc).not.toContain('k@x.sa');
    const audit = await ownerQuery<{ after: unknown }>(`SELECT after FROM audit_logs WHERE action = 'contact.create'`);
    expect(JSON.stringify(audit)).not.toContain('501234567');

    const dnc = (await owner.put(`/crm/contacts/${c.id}/dnc`, { doNotContact: true, reason: 'طلب العميل عدم التواصل' }).expect(200)).body;
    expect(dnc.doNotContact).toBe(true);
    expect(dnc.dncAt).not.toBeNull();
    const timeline = (await owner.get(`/crm/accounts/${a.id}/timeline`).expect(200)).body.map((x: { type: string }) => x.type);
    expect(timeline).toContain('contact_dnc_on');

    await owner.delete(`/crm/contacts/${c.id}`).expect(204);
    const [erased] = await ownerQuery<{ phone_enc: string | null; full_name: string }>('SELECT phone_enc, full_name FROM contacts WHERE id = $1', [c.id]);
    expect(erased).toEqual({ phone_enc: null, full_name: '—' });
    expect((await owner.get(`/crm/accounts/${a.id}/contacts`).expect(200)).body).toEqual([]);
  });
});

describe('opportunities', () => {
  it('starts in the first open stage; closing requires a reason of the right kind; history is kept', async () => {
    const a = (await owner.post('/crm/accounts', { name: 'موزع' }).expect(201)).body;
    const o = (await owner.post('/crm/opportunities', { accountId: a.id, title: 'عقد نقل', amount: 50000 }).expect(201)).body;
    expect(o.stageId).toBe(stage('new').id);

    const noReason = await owner.post(`/crm/opportunities/${o.id}/stage`, { stageId: stage('won').id });
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    const wrongKind = await owner.post(`/crm/opportunities/${o.id}/stage`, { stageId: stage('won').id, outcomeReasonId: reason('loss').id });
    expect(wrongKind.status).toBe(400);

    const won = (await owner.post(`/crm/opportunities/${o.id}/stage`, { stageId: stage('won').id, outcomeReasonId: reason('win').id }).expect(200)).body;
    expect(won).toMatchObject({ stageCategory: 'won', outcomeReasonId: reason('win').id });
    expect(won.closedAt).not.toBeNull();
    expect((await owner.get(`/crm/accounts/${a.id}`)).body.status).toBe('customer');

    const reopened = (await owner.post(`/crm/opportunities/${o.id}/stage`, { stageId: stage('negotiation').id }).expect(200)).body;
    expect(reopened.closedAt).toBeNull();
    const detail = (await owner.get(`/crm/opportunities/${o.id}`).expect(200)).body;
    expect(detail.history.map((h: { toStageId: string }) => h.toStageId)).toEqual([stage('new').id, stage('won').id, stage('negotiation').id]);
  });

  it('reps only see opportunities they own or on their accounts', async () => {
    const theirs = (await owner.post('/crm/accounts', { name: 'حساب المندوب', ownerMembershipId: repId }).expect(201)).body;
    const ours = (await owner.post('/crm/accounts', { name: 'حساب الإدارة' }).expect(201)).body;
    const o1 = (await owner.post('/crm/opportunities', { accountId: theirs.id, title: 'فرصة أ' }).expect(201)).body;
    const o2 = (await owner.post('/crm/opportunities', { accountId: ours.id, title: 'فرصة ب' }).expect(201)).body;
    expect((await rep.get('/crm/opportunities').expect(200)).body.map((o: { id: string }) => o.id)).toEqual([o1.id]);
    await rep.get(`/crm/opportunities/${o2.id}`).expect(404);
    await rep.post(`/crm/opportunities/${o2.id}/stage`, { stageId: stage('qualified').id }).expect(404);
  });
});

describe('visits and tasks', () => {
  it('scheduling and completing a visit advances the deal by event, creates the follow-up task and timeline', async () => {
    const a = (await owner.post('/crm/accounts', { name: 'مستودع', ownerMembershipId: repId }).expect(201)).body;
    const o = (await owner.post('/crm/opportunities', { accountId: a.id, title: 'نقل مبرد' }).expect(201)).body;
    const v = (await owner.post('/crm/visits', { accountId: a.id, opportunityId: o.id, scheduledStart: inDays(1), purpose: 'تعريف بالخدمة' }).expect(201)).body;
    expect(v.repMembershipId).toBe(repId); // defaults to the account owner
    expect((await owner.get(`/crm/opportunities/${o.id}`)).body.stageId).toBe(stage('visit_scheduled').id);

    expect((await owner.post(`/crm/visits/${v.id}/check-in`, {})).status).toBe(403); // only the assigned rep
    const checked = (await rep.post(`/crm/visits/${v.id}/check-in`, { lat: 24.7136, lng: 46.6753, accuracyM: 12 }).expect(200)).body;
    expect(checked.status).toBe('in_progress');

    const due = inDays(3);
    const done = (await rep
      .post(`/crm/visits/${v.id}/complete`, { outcome: 'interested', interestLevel: 4, nextStep: 'send_proposal', nextFollowUpAt: due, notes: 'مهتم بالنقل المبرد' })
      .expect(200)).body;
    expect(done.status).toBe('completed');
    expect(done.followUpTaskId).toBeTruthy();
    const detail = (await owner.get(`/crm/opportunities/${o.id}`)).body;
    expect(detail.stageId).toBe(stage('visit_done').id);
    expect(detail.history.at(-1)).toMatchObject({ changedByType: 'system_event' });
    expect(detail.history.at(-1).evidence).toMatchObject({ visitId: v.id, event: 'visit_completed' });

    const tasks = (await rep.get('/crm/tasks?view=mine').expect(200)).body;
    expect(tasks[0]).toMatchObject({ id: done.followUpTaskId, type: 'send_proposal', assigneeMembershipId: repId, createdByType: 'system' });
    await rep.post(`/crm/visits/${v.id}/complete`, { outcome: 'interested', nextStep: 'none' }).expect(409);

    const timeline = (await owner.get(`/crm/accounts/${a.id}/timeline`)).body.map((x: { type: string }) => x.type);
    expect(timeline).toEqual(expect.arrayContaining(['visit_scheduled', 'visit_completed', 'stage_changed', 'task_created']));
  });

  it('event-based moves never go backwards or close a deal; "not met" does not advance', async () => {
    const a = (await owner.post('/crm/accounts', { name: 'مصنع ب', ownerMembershipId: repId }).expect(201)).body;
    const o = (await owner.post('/crm/opportunities', { accountId: a.id, title: 'x y' }).expect(201)).body;
    await owner.post(`/crm/opportunities/${o.id}/stage`, { stageId: stage('negotiation').id }).expect(200);
    const v = (await owner.post('/crm/visits', { accountId: a.id, opportunityId: o.id, scheduledStart: inDays(1) }).expect(201)).body;
    await rep.post(`/crm/visits/${v.id}/complete`, { outcome: 'interested', nextStep: 'none' }).expect(200);
    expect((await owner.get(`/crm/opportunities/${o.id}`)).body.stageId).toBe(stage('negotiation').id);

    const o2 = (await owner.post('/crm/opportunities', { accountId: a.id, title: 'y z' }).expect(201)).body;
    const v2 = (await owner.post('/crm/visits', { accountId: a.id, opportunityId: o2.id, scheduledStart: inDays(2) }).expect(201)).body;
    await rep.post(`/crm/visits/${v2.id}/complete`, { outcome: 'not_met', nextStep: 'another_visit' }).expect(200);
    expect((await owner.get(`/crm/opportunities/${o2.id}`)).body.stageId).toBe(stage('visit_scheduled').id);
  });

  it('visit scheduling, rescheduling and cancelling', async () => {
    const a = (await owner.post('/crm/accounts', { name: 'عميل' }).expect(201)).body;
    const bad = await owner.post('/crm/visits', { accountId: a.id, scheduledStart: inDays(2), scheduledEnd: inDays(1) });
    expect(bad.status).toBe(400);
    const v = (await owner.post('/crm/visits', { accountId: a.id, scheduledStart: inDays(1), repMembershipId: repId }).expect(201)).body;
    await owner.patch(`/crm/visits/${v.id}`, { scheduledStart: inDays(2) }).expect(200);
    await owner.post(`/crm/visits/${v.id}/cancel`).expect(200);
    await owner.post(`/crm/visits/${v.id}/cancel`).expect(409);
    const list = (await rep.get(`/crm/visits?from=${inDays(0)}&to=${inDays(7)}`).expect(200)).body;
    expect(list[0]).toMatchObject({ id: v.id, status: 'cancelled' });
    expect((await rep.get(`/crm/visits?from=${inDays(0)}&to=${inDays(200)}`)).status).toBe(400);
  });

  it('task views, completion and rep restrictions', async () => {
    const a = (await owner.post('/crm/accounts', { name: 'عميل', ownerMembershipId: repId }).expect(201)).body;
    const overdue = (await rep.post('/crm/tasks', { title: 'اتصال متأخر', type: 'call', dueAt: inDays(-1), accountId: a.id }).expect(201)).body;
    await rep.post('/crm/tasks', { title: 'لاحقاً', dueAt: inDays(5) }).expect(201);
    expect((await rep.get('/crm/tasks?view=overdue')).body.map((t: { id: string }) => t.id)).toEqual([overdue.id]);
    expect((await rep.post('/crm/tasks', { title: 'لغيري', assigneeMembershipId: (await owner.get('/team/members')).body.find((m: { role: string }) => m.role === 'owner').id })).status).toBe(403);
    const done = (await rep.patch(`/crm/tasks/${overdue.id}`, { status: 'done' }).expect(200)).body;
    expect(done.completedAt).not.toBeNull();
    expect((await rep.get('/crm/tasks?view=done')).body).toHaveLength(1);
    expect((await owner.get(`/crm/accounts/${a.id}/timeline`)).body.map((x: { type: string }) => x.type)).toContain('task_completed');
    // Manager's own task is invisible to the rep.
    const mgrTask = (await owner.post('/crm/tasks', { title: 'مهمة المالك' }).expect(201)).body;
    await rep.patch(`/crm/tasks/${mgrTask.id}`, { status: 'done' }).expect(404);
  });
});

describe('dashboard', () => {
  it('computes the KPI definitions from real data', async () => {
    const a = (await owner.post('/crm/accounts', { name: 'عميل 1', ownerMembershipId: repId }).expect(201)).body;
    const b = (await owner.post('/crm/accounts', { name: 'عميل 2' }).expect(201)).body;
    const o1 = (await owner.post('/crm/opportunities', { accountId: a.id, title: 'رابحة', amount: 10000 }).expect(201)).body;
    const o2 = (await owner.post('/crm/opportunities', { accountId: b.id, title: 'خاسرة', amount: 5000 }).expect(201)).body;
    await owner.post('/crm/opportunities', { accountId: b.id, title: 'مفتوحة', amount: 7000 }).expect(201);
    await owner.post(`/crm/opportunities/${o1.id}/stage`, { stageId: stage('proposal_sent').id }).expect(200);
    await owner.post(`/crm/opportunities/${o1.id}/stage`, { stageId: stage('won').id, outcomeReasonId: reason('win').id }).expect(200);
    await owner.post(`/crm/opportunities/${o2.id}/stage`, { stageId: stage('lost').id, outcomeReasonId: reason('loss').id }).expect(200);
    const v = (await owner.post('/crm/visits', { accountId: a.id, scheduledStart: new Date(Date.now() - 3600_000).toISOString() }).expect(201)).body;
    await rep.post(`/crm/visits/${v.id}/complete`, { outcome: 'interested', nextStep: 'none' }).expect(200);
    await owner.post('/crm/visits', { accountId: b.id, scheduledStart: new Date(Date.now() - 1800_000).toISOString(), repMembershipId: repId }).expect(201);
    await owner.post('/crm/tasks', { title: 'متأخرة', dueAt: inDays(-1) }).expect(201);

    const d = (await owner.get(`/reports/dashboard?from=${inDays(-1)}&to=${inDays(1)}`).expect(200)).body;
    expect(d.totals).toMatchObject({
      accounts: 2, newAccounts: 2, won: 1, lost: 1, winRate: 0.5, openOpportunities: 1, pipelineValue: 7000, wonValue: 10000,
      proposalsSent: 1, visitsScheduled: 2, visitsCompleted: 1, visitCompletionRate: 0.5, overdueTasks: 1,
    });
    expect(d.lossReasons).toEqual([{ label: reason('loss').label, count: 1 }]);
    expect(d.byRep.find((r: { membershipId: string }) => r.membershipId === repId)).toMatchObject({ visitsCompleted: 1 });
    expect(d.stageFunnel.find((s: { name: string }) => s.name === stage('new').name).count).toBe(1);
    await rep.get(`/reports/dashboard?from=${inDays(-1)}&to=${inDays(1)}`).expect(403);
  });

  it('funnel combines track pipelines; a visit completed before its scheduled time still counts as completed', async () => {
    const s = (await owner.post('/crm/tracks', { key: 'shippers', name: 'طالبو النقل' }).expect(201)).body as CrmSettingsDto;
    const trackId = s.tracks[0]!.id;
    const a = (await owner.post('/crm/accounts', { name: 'مصنع', trackId, ownerMembershipId: repId }).expect(201)).body;
    await owner.post('/crm/opportunities', { accountId: a.id, title: 'في مسار', amount: 1000 }).expect(201);
    const v = (await owner.post('/crm/visits', { accountId: a.id, scheduledStart: inDays(0.05) }).expect(201)).body; // ~1h from now
    await rep.post(`/crm/visits/${v.id}/complete`, { outcome: 'interested', nextStep: 'none' }).expect(200);

    const all = (await owner.get(`/reports/dashboard?from=${inDays(-1)}&to=${inDays(0.01)}`).expect(200)).body;
    expect(all.stageFunnel.find((x: { name: string }) => x.name === stage('new').name)).toMatchObject({ count: 1, value: 1000 });
    expect(all.totals.visitsCompleted).toBe(1);
    expect(all.totals.visitsScheduled).toBe(0); // it is scheduled after the period end
    expect(all.byRep.find((r: { membershipId: string }) => r.membershipId === repId).visitsCompleted).toBe(1);
    const filtered = (await owner.get(`/reports/dashboard?from=${inDays(-1)}&to=${inDays(1)}&trackId=${trackId}`).expect(200)).body;
    expect(filtered.stageFunnel[0]).toMatchObject({ count: 1 });
  });
});
