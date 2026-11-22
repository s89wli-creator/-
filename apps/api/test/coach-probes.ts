import { expect } from 'vitest';
import type { CrmFixtures } from './crm-probes';
import { ownerQuery, type TestClient } from './helpers';

export interface CoachFixtures { a: TestClient; b: TestClient; B: { reportId: string; notificationId: string; memberId: string; tenantId: string } }

const one = async (q: string, p: unknown[]) => (await ownerQuery<Record<string, unknown>>(q, p))[0]!;

/** Company B: a coach report, a scheduled job and a notification. */
export async function createCoachFixtures(crm: CrmFixtures, bRepMembershipId: string): Promise<CoachFixtures> {
  const { a, b } = crm;
  const report = (await b.post('/coach/reports', { membershipId: bRepMembershipId, days: 7 }).expect(201)).body;
  await b.patch('/automation/jobs/morning_brief', { enabled: true, hour: 5 }).expect(200);
  const tenantId = String((await one('SELECT tenant_id FROM coach_reports WHERE id = $1', [report.id])).tenant_id);
  const userId = String((await one("SELECT id FROM users WHERE email = 'owner@b.sa'", [])).id);
  const n = await one("INSERT INTO notifications (tenant_id, user_id, kind, title, body) VALUES ($1, $2, 'morning_brief', 'سر الشركة ب', 'تفاصيل ب') RETURNING id", [tenantId, userId]);
  return { a, b, B: { reportId: report.id, notificationId: String(n.id), memberId: bRepMembershipId, tenantId } };
}

export function coachProbes(f: () => CoachFixtures): Record<string, () => Promise<void>> {
  const job = () => one("SELECT enabled, hour FROM scheduled_jobs WHERE tenant_id = $1 AND job = 'morning_brief'", [f().B.tenantId]);
  return {
    'GET /api/coach/team': async () => {
      const s = JSON.stringify((await f().a.get('/coach/team').expect(200)).body);
      expect(s).not.toContain(f().B.memberId);
      expect(s).not.toContain('owner@b.sa');
    },
    'GET /api/coach/me': async () => {
      expect(JSON.stringify((await f().a.get('/coach/me').expect(200)).body)).not.toContain(f().B.memberId);
    },
    'POST /api/coach/reports': async () => {
      await f().a.post('/coach/reports', { membershipId: f().B.memberId, days: 7 }).expect(404);
    },
    'GET /api/coach/reports': async () => {
      expect((await f().a.get(`/coach/reports?membershipId=${f().B.memberId}`).expect(200)).body).toEqual([]);
      expect(JSON.stringify((await f().a.get('/coach/reports').expect(200)).body)).not.toContain(f().B.reportId);
    },
    'GET /api/coach/reports/:id': async () => {
      await f().a.get(`/coach/reports/${f().B.reportId}`).expect(404);
    },
    'GET /api/automation/jobs': async () => {
      const jobs = (await f().a.get('/automation/jobs').expect(200)).body as { job: string; hour: number }[];
      expect(jobs.find((j) => j.job === 'morning_brief')!.hour).not.toBe(5);
    },
    'PATCH /api/automation/jobs/:job': async () => {
      await f().a.patch('/automation/jobs/morning_brief', { enabled: false }).expect(200); // A's own row only
      expect(await job()).toEqual({ enabled: true, hour: 5 });
    },
    'POST /api/automation/jobs/:job/run': async () => {
      await f().a.post('/automation/jobs/morning_brief/run').expect(200);
      expect((await ownerQuery('SELECT 1 FROM job_runs WHERE tenant_id = $1', [f().B.tenantId])).length).toBe(0);
    },
    'GET /api/automation/runs': async () => {
      expect(JSON.stringify((await f().a.get('/automation/runs').expect(200)).body)).not.toContain(f().B.tenantId);
    },
    'GET /api/notifications': async () => {
      expect(JSON.stringify((await f().a.get('/notifications').expect(200)).body)).not.toContain('سر الشركة ب');
    },
    'POST /api/notifications/:id/read': async () => {
      await f().a.post(`/notifications/${f().B.notificationId}/read`).expect(404);
      expect((await one('SELECT read_at FROM notifications WHERE id = $1', [f().B.notificationId])).read_at).toBeNull();
    },
    'POST /api/notifications/read-all': async () => {
      await f().a.post('/notifications/read-all').expect(204);
      expect((await one('SELECT read_at FROM notifications WHERE id = $1', [f().B.notificationId])).read_at).toBeNull();
    },
  };
}
