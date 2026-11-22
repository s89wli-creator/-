import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { numbersIn, periodFor } from '../src/coach/coach.service';
import { SchedulerService, nextRunAt } from '../src/coach/scheduler.service';
import { fake, installDefaultAgents } from './ai-fake';
import { addMember, outbox, ownerQuery, registerCompany, resetDb, startApp, type TestClient } from './helpers';

let app: INestApplication;
let owner: TestClient;
let rep: TestClient;
let repMembership: string;
let tenantId: string;
let accountId: string;

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const scheduler = () => app.get(SchedulerService);

/** A completed visit by the rep, moved back `daysAgo` days so it falls in the coaching period. */
async function completedVisit(daysAgo: number, outcome = 'interested') {
  const v = (await rep.post('/crm/visits', { accountId, scheduledStart: inHours(0) }).expect(201)).body;
  await rep.post(`/crm/visits/${v.id}/check-in`, { lat: 24.7, lng: 46.6, accuracyM: 10 }).expect(200);
  await rep.post(`/crm/visits/${v.id}/complete`, { outcome, nextStep: 'none', interestLevel: 4 }).expect(200);
  await ownerQuery(`UPDATE visits SET scheduled_start = now() - ($2 || ' days')::interval, check_in_at = now() - ($2 || ' days')::interval,
    check_out_at = now() - ($2 || ' days')::interval + interval '30 minutes' WHERE id = $1`, [v.id, String(daysAgo)]);
  return v.id as string;
}

beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  outbox(app).length = 0;
  fake(app).reset();
  installDefaultAgents(fake(app));
  ({ client: owner, tenantId } = await registerCompany(app, { email: 'owner@acme.sa', company: 'Acme' }));
  ({ client: rep, membershipId: repMembership } = await addMember(app, owner, 'rep@acme.sa', 'rep'));
  accountId = (await owner.post('/crm/accounts', { name: 'مصنع الشرقية', ownerMembershipId: repMembership }).expect(201)).body.id;
});

describe('helpers', () => {
  it('computes whole-day periods in Riyadh time and the next run', () => {
    const p = periodFor(7, new Date('2026-11-22T05:00:00Z')); // 08:00 Riyadh, Sunday
    expect(p).toMatchObject({ fromDate: '2026-11-15', toDate: '2026-11-21' });
    expect(p.to.toISOString()).toBe('2026-11-21T21:00:00.000Z');
    // Sunday 07:00 Riyadh has passed at 08:00 -> next is Monday 07:00 (04:00Z) for a Sun–Thu job.
    expect(nextRunAt(7, 0, [0, 1, 2, 3, 4], new Date('2026-11-22T05:00:00Z'))!.toISOString()).toBe('2026-11-23T04:00:00.000Z');
    // Weekly on Sunday 08:00 Riyadh, asked on Thursday -> Sunday.
    expect(nextRunAt(8, 0, [0], new Date('2026-11-19T10:00:00Z'))!.toISOString()).toBe('2026-11-22T05:00:00.000Z');
    expect(numbersIn('أنجزت ٣ زيارات من 12، أي 25% و 1,200 ر.س')).toEqual([3, 12, 25, 1200]);
  });
});

describe('Sales Coach', () => {
  it('counts the rep activity from the records (not from the model) and compares with the team', async () => {
    await completedVisit(2);
    await completedVisit(3, 'not_interested');
    await completedVisit(20); // outside the 7-day period
    const t = (await owner.get('/coach/team?days=7').expect(200)).body;
    const r = t.members.find((m: { membershipId: string }) => m.membershipId === repMembership);
    expect(r.metrics).toMatchObject({ visits_planned: 2, visits_completed: 2, visit_completion_pct: 100, visits_interested: 1, avg_interest: 4 });
    expect(t.median.visits_completed).toBe(2); // median over reps only
    expect((await owner.get('/coach/team?days=30').expect(200)).body.members.find((m: { membershipId: string }) => m.membershipId === repMembership).metrics.visits_completed).toBe(3);
  });

  it('reps see only their own numbers and reports; the team view needs reports.read', async () => {
    await rep.get('/coach/team').expect(403);
    const me = (await rep.get('/coach/me').expect(200)).body;
    expect(me.members.map((m: { membershipId: string }) => m.membershipId)).toEqual([repMembership]);
    const ownerMembership = (await ownerQuery<{ id: string }>("SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'owner@acme.sa'"))[0]!.id;
    await rep.post('/coach/reports', { membershipId: ownerMembership, days: 7 }).expect(404);
    const mgr = await owner.post('/coach/reports', { membershipId: repMembership, days: 7 }).expect(201);
    await rep.get(`/coach/reports/${mgr.body.id}`).expect(200); // about the rep: the rep can read it
    const ownReport = (await owner.post('/coach/reports', { days: 7 }).expect(201)).body;
    await rep.get(`/coach/reports/${ownReport.id}`).expect(404);
    expect((await rep.get('/coach/reports').expect(200)).body.map((x: { id: string }) => x.id)).toEqual([mgr.body.id]);
  });

  it('keeps only coaching tied to real numbers and approved objection answers', async () => {
    await completedVisit(1);
    const obj = (await owner.post('/brain/items', { section: 'objections', title: 'السعر مرتفع', fields: { objection: 'السعر مرتفع', response: 'التبريد المستمر يقلل التلف' } }).expect(201)).body;
    await owner.post(`/brain/items/${obj.id}/approve`).expect(200);
    const r = (await rep.post('/coach/reports', { days: 7 }).expect(201)).body;
    expect(r.headline).toBe('أنجزت 1 زيارات هذا الأسبوع');
    expect(r.strengths).toEqual([{ text: 'أكملت 1 زيارات', metric: 'visits_completed' }]);
    expect(r.improvements.map((x: { metric: string }) => x.metric)).toEqual(['tasks_overdue']);
    expect(r.objectionTips).toEqual([expect.objectContaining({ ref: `brain:${obj.id}`, refLabel: 'السعر مرتفع' })]);
    expect(r.dropped.map((d: { reason: string }) => d.reason).sort()).toEqual(['no_approved_source', 'unknown_metric', 'unsupported_number']);
    expect(r.metrics.visits_completed).toBe(1);
    const [run] = await ownerQuery<{ agent: string; trigger_type: string }>('SELECT agent, trigger_type FROM agent_runs WHERE id = $1', [r.agentRunId]);
    expect(run).toEqual({ agent: 'sales_coach', trigger_type: 'user' });
  });
});

describe('scheduled agents', () => {
  it('only owners and managers manage schedules; enabling sets the next run', async () => {
    await rep.get('/automation/jobs').expect(403);
    const jobs = (await owner.get('/automation/jobs').expect(200)).body;
    expect(jobs.map((j: { job: string; enabled: boolean }) => [j.job, j.enabled])).toEqual([['morning_brief', false], ['visit_briefs', false], ['weekly_coach', false]]);
    await owner.patch('/automation/jobs/bogus', { enabled: true }).expect(400);
    const j = (await owner.patch('/automation/jobs/morning_brief', { enabled: true, hour: 6, minute: 45 }).expect(200)).body;
    expect(j).toMatchObject({ enabled: true, hour: 6, minute: 45, usesAi: false });
    expect(new Date(j.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect((await ownerQuery<{ action: string }>("SELECT action FROM audit_logs WHERE action = 'automation.update'")).length).toBe(1);
  });

  it('runs due jobs once (lease), as each person, and delivers in the app and by email when enabled', async () => {
    await rep.post('/crm/visits', { accountId, scheduledStart: new Date(Date.now() + 60_000).toISOString() }).expect(201);
    await rep.post('/crm/tasks', { title: 'اتصل بالمشتري', accountId, dueAt: inHours(-2) }).expect(201);
    await owner.patch('/automation/jobs/morning_brief', { enabled: true, email: true, days: [0, 1, 2, 3, 4, 5, 6] }).expect(200);
    await ownerQuery("UPDATE scheduled_jobs SET next_run_at = now() - interval '1 minute'");
    expect(await scheduler().tick()).toBe(1);
    expect(await scheduler().tick()).toBe(0); // leased / rescheduled: not run twice

    const mine = (await rep.get('/notifications').expect(200)).body;
    expect(mine.unread).toBe(1);
    expect(mine.items[0].title).toContain('1 زيارات و1 مهام');
    expect(mine.items[0].body).toContain('مصنع الشرقية');
    expect(mine.items[0].body).toContain('اتصل بالمشتري');
    expect(outbox(app).some((m) => m.to === 'rep@acme.sa' && m.subject.includes('صباح الخير'))).toBe(true);
    const ownerNotes = (await owner.get('/notifications').expect(200)).body;
    expect(ownerNotes.items[0].body).toContain('زيارات الفريق اليوم: 1');
    expect(JSON.stringify(ownerNotes)).not.toContain('اتصل بالمشتري'); // the rep's own task is the rep's

    const [job] = await ownerQuery<{ last_status: string; next_run_at: Date }>('SELECT last_status, next_run_at FROM scheduled_jobs');
    expect(job!.last_status).toBe('succeeded');
    expect(job!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    const runs = (await owner.get('/automation/runs').expect(200)).body;
    expect(runs[0]).toMatchObject({ job: 'morning_brief', trigger: 'schedule', status: 'succeeded', detail: { notified: 2, emailed: 2 } });
  });

  it('skips suspended companies', async () => {
    await owner.patch('/automation/jobs/morning_brief', { enabled: true, days: [0, 1, 2, 3, 4, 5, 6] }).expect(200);
    await ownerQuery("UPDATE scheduled_jobs SET next_run_at = now() - interval '1 minute'");
    await ownerQuery("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantId]);
    expect(await scheduler().tick()).toBe(0);
  });

  it('prepares today\'s visit briefs and stops at the budget', async () => {
    await rep.post('/crm/visits', { accountId, scheduledStart: new Date(Date.now() + 60_000).toISOString() }).expect(201);
    const run = (await owner.post('/automation/jobs/visit_briefs/run').expect(200)).body;
    expect(run).toMatchObject({ job: 'visit_briefs', trigger: 'manual', status: 'succeeded', detail: { prepared: 1 } });
    expect((await ownerQuery('SELECT 1 FROM visit_briefs')).length).toBe(1);
    expect((await rep.get('/notifications').expect(200)).body.items[0].kind).toBe('visit_briefs');
    // Already prepared: nothing to do (no second model call).
    expect((await owner.post('/automation/jobs/visit_briefs/run').expect(200)).body.detail).toEqual({ prepared: 0 });

    await rep.post('/crm/visits', { accountId, scheduledStart: new Date(Date.now() + 120_000).toISOString() }).expect(201);
    await owner.patch('/ai/settings', { monthlyBudgetUsd: 0 }).expect(200);
    const blocked = (await owner.post('/automation/jobs/visit_briefs/run').expect(200)).body;
    expect(blocked).toMatchObject({ status: 'skipped', detail: { prepared: 0, stopped: 'AI_BUDGET_EXCEEDED' } });
  });

  it('weekly coach: a report per rep, shared with the rep and the managers', async () => {
    await completedVisit(2);
    const run = (await owner.post('/automation/jobs/weekly_coach/run').expect(200)).body;
    expect(run).toMatchObject({ status: 'succeeded', detail: { reports: 1 } });
    const [r] = await ownerQuery<{ trigger: string; membership_id: string }>('SELECT trigger, membership_id FROM coach_reports');
    expect(r).toEqual({ trigger: 'schedule', membership_id: repMembership });
    expect((await rep.get('/notifications').expect(200)).body.items[0].title).toBe('تقرير المدرب الأسبوعي جاهز');
    expect((await owner.get('/notifications').expect(200)).body.items[0].title).toContain('Member rep@acme.sa');
  });

  it('notifications are private and can be marked read', async () => {
    await owner.patch('/automation/jobs/morning_brief', { enabled: true }).expect(200);
    await rep.post('/crm/visits', { accountId, scheduledStart: new Date(Date.now() + 60_000).toISOString() }).expect(201);
    await owner.post('/automation/jobs/morning_brief/run').expect(200);
    const n = (await rep.get('/notifications').expect(200)).body.items[0];
    await owner.post(`/notifications/${n.id}/read`).expect(404);
    await rep.post(`/notifications/${n.id}/read`).expect(204);
    expect((await rep.get('/notifications').expect(200)).body.unread).toBe(0);
    await owner.post('/notifications/read-all').expect(204);
    expect((await owner.get('/notifications').expect(200)).body.unread).toBe(0);
  });
});
