import type { INestApplication } from '@nestjs/common';
import { permissionsForRole } from '@rakan/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, addMember, client, outbox, ownerQuery, registerCompany, resetDb, startApp } from './helpers';

let app: INestApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  outbox(app).length = 0;
});

describe('invitations', () => {
  it('owner invites a rep; rep accepts, signs in and gets only rep permissions', async () => {
    const { client: owner } = await registerCompany(app, { email: 'o@acme.sa', company: 'Acme' });
    const inv = await owner.post('/team/invitations', { email: 'Rep@Acme.sa', role: 'rep' }).expect(201);
    expect(inv.body.email).toBe('rep@acme.sa');
    expect((await owner.get('/team/invitations').expect(200)).body).toHaveLength(1);

    const mail = outbox(app)[0]!;
    expect(mail.subject).toContain('Acme');
    const token = decodeURIComponent(mail.text.match(/\/invite\/([^\s]+)/)![1]!);

    const anon = await client(app);
    const preview = (await anon.get(`/invitations/${encodeURIComponent(token)}`).expect(200)).body;
    expect(preview).toMatchObject({ tenantName: 'Acme', email: 'rep@acme.sa', role: 'rep', status: 'pending', accountExists: false });

    await anon.post('/invitations/accept', { token, fullName: 'Rep One', password: PASSWORD }).expect(200);
    const me = (await anon.get('/auth/me').expect(200)).body;
    expect(me.activeTenant.role).toBe('rep');
    expect(me.activeTenant.permissions).toEqual([...permissionsForRole('rep')]);
    expect(me.activeTenant.permissions).not.toContain('team.member.read');

    // Single use
    const again = await (await client(app)).post('/invitations/accept', { token, fullName: 'X Y', password: PASSWORD });
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe('INVITATION_USED');
    expect((await owner.get('/team/invitations').expect(200)).body).toHaveLength(0);
  });

  it('existing account must sign in to accept, then can switch between companies', async () => {
    const { client: a } = await registerCompany(app, { email: 'a@a.sa', company: 'Alpha' });
    const { client: b, tenantId: betaId } = await registerCompany(app, { email: 'b@b.sa', company: 'Beta' });
    await b.post('/team/invitations', { email: 'a@a.sa', role: 'manager' }).expect(201);
    const token = decodeURIComponent(outbox(app).pop()!.text.match(/\/invite\/([^\s]+)/)![1]!);

    const anon = await client(app);
    const res = await anon.post('/invitations/accept', { token });
    expect(res.body.error.code).toBe('LOGIN_REQUIRED');

    await a.post('/invitations/accept', { token }).expect(200);
    const me = (await a.get('/auth/me').expect(200)).body;
    expect(me.activeTenant.id).toBe(betaId);
    expect(me.activeTenant.role).toBe('manager');
    expect(me.memberships.map((m: { tenantName: string }) => m.tenantName).sort()).toEqual(['Alpha', 'Beta']);

    const alphaId = me.memberships.find((m: { tenantName: string }) => m.tenantName === 'Alpha').tenantId;
    await a.post('/auth/switch-tenant', { tenantId: alphaId }).expect(200);
    expect((await a.get('/auth/me').expect(200)).body.activeTenant.role).toBe('owner');
  });

  it('rejects expired invitations and duplicate members', async () => {
    const { client: owner } = await registerCompany(app, { email: 'o@acme.sa', company: 'Acme' });
    await owner.post('/team/invitations', { email: 'late@acme.sa', role: 'rep' }).expect(201);
    const token = decodeURIComponent(outbox(app).pop()!.text.match(/\/invite\/([^\s]+)/)![1]!);
    await ownerQuery(`UPDATE invitations SET expires_at = now() - interval '1 minute'`);
    const res = await (await client(app)).post('/invitations/accept', { token, fullName: 'Late Rep', password: PASSWORD });
    expect(res.body.error.code).toBe('INVITATION_EXPIRED');

    const dup = await owner.post('/team/invitations', { email: 'o@acme.sa', role: 'rep' });
    expect(dup.body.error.code).toBe('ALREADY_MEMBER');
  });

  it('re-inviting replaces the pending invitation; revoking invalidates it', async () => {
    const { client: owner } = await registerCompany(app, { email: 'o@acme.sa', company: 'Acme' });
    await owner.post('/team/invitations', { email: 'r@acme.sa', role: 'rep' }).expect(201);
    const first = decodeURIComponent(outbox(app).pop()!.text.match(/\/invite\/([^\s]+)/)![1]!);
    const second = (await owner.post('/team/invitations', { email: 'r@acme.sa', role: 'readonly' }).expect(201)).body;
    expect((await owner.get('/team/invitations')).body).toHaveLength(1);
    await (await client(app)).get(`/invitations/${encodeURIComponent(first)}`).expect(404);
    await owner.delete(`/team/invitations/${second.id}`).expect(204);
    expect((await owner.get('/team/invitations')).body).toHaveLength(0);
  });
});

describe('role-based access control', () => {
  it('rep and readonly cannot manage the team or company', async () => {
    const { client: owner } = await registerCompany(app, { email: 'o@acme.sa', company: 'Acme' });
    const { client: rep } = await addMember(app, owner, 'rep@acme.sa', 'rep');
    const { client: ro } = await addMember(app, owner, 'ro@acme.sa', 'readonly');

    for (const [c, path] of [
      [rep, '/team/members'], [rep, '/audit-logs'], [rep, '/team/territories'], [ro, '/audit-logs'],
    ] as const) {
      const res = await c.get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    await rep.get('/tenant').expect(200);
    await ro.get('/team/members').expect(200);
    await rep.patch('/tenant', { name: 'Hacked' }).expect(403);
    await ro.patch('/tenant', { name: 'Hacked' }).expect(403);
    await ro.post('/team/invitations', { email: 'x@acme.sa', role: 'rep' }).expect(403);
    await ro.post('/team/territories', { name: 'الرياض' }).expect(403);
  });

  it('manager cannot invite or modify owners, nor update company settings', async () => {
    const { client: owner } = await registerCompany(app, { email: 'o@acme.sa', company: 'Acme' });
    const { client: mgr } = await addMember(app, owner, 'm@acme.sa', 'manager');
    const members = (await owner.get('/team/members')).body as { id: string; role: string }[];
    const ownerId = members.find((m) => m.role === 'owner')!.id;

    expect((await mgr.post('/team/invitations', { email: 'o2@acme.sa', role: 'owner' })).status).toBe(403);
    expect((await mgr.patch(`/team/members/${ownerId}`, { status: 'disabled' })).status).toBe(403);
    expect((await mgr.patch('/tenant', { name: 'X Co' })).status).toBe(403);
    await mgr.post('/team/invitations', { email: 'rep@acme.sa', role: 'rep' }).expect(201);
  });

  it('nobody can change their own role or status (prevents self-lockout)', async () => {
    const { client: owner } = await registerCompany(app, { email: 'o@acme.sa', company: 'Acme' });
    const [self] = (await owner.get('/team/members')).body as { id: string }[];
    const res = await owner.patch(`/team/members/${self!.id}`, { role: 'manager' });
    expect(res.status).toBe(403);
    expect((await owner.patch(`/team/members/${self!.id}`, { status: 'disabled' })).status).toBe(403);
    await owner.patch(`/team/members/${self!.id}`, { title: 'المدير التنفيذي' }).expect(200);
  });

  it('an owner can demote another owner; the company always keeps an active owner', async () => {
    const { client: owner } = await registerCompany(app, { email: 'o@acme.sa', company: 'Acme' });
    const { client: owner2, membershipId: owner2Id } = await addMember(app, owner, 'o2@acme.sa', 'owner');
    const ownerId = ((await owner.get('/team/members')).body as { id: string; email: string }[]).find((m) => m.email === 'o@acme.sa')!.id;
    await owner2.patch(`/team/members/${ownerId}`, { role: 'manager' }).expect(200);
    expect((await owner.patch(`/team/members/${owner2Id}`, { status: 'disabled' })).status).toBe(403);
    const owners = await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE role = 'owner' AND status = 'active'`);
    expect(owners[0]!.n).toBe(1);
  });

  it('disabling a member or changing a role takes effect on the next request', async () => {
    const { client: owner } = await registerCompany(app, { email: 'o@acme.sa', company: 'Acme' });
    const { client: mgr, membershipId } = await addMember(app, owner, 'm@acme.sa', 'manager');
    await mgr.get('/team/members').expect(200);
    await owner.patch(`/team/members/${membershipId}`, { role: 'rep' }).expect(200);
    await mgr.get('/team/members').expect(403);
    await owner.patch(`/team/members/${membershipId}`, { status: 'disabled' }).expect(200);
    const res = await mgr.get('/tenant');
    expect(res.body.error.code).toBe('NO_ACTIVE_TENANT');
    const me = (await mgr.get('/auth/me').expect(200)).body;
    expect(me.activeTenant).toBeNull();
    expect(me.memberships).toEqual([]);
  });
});

describe('company settings', () => {
  it('owner updates settings with validation; change is audited with before/after', async () => {
    const { client: owner, tenantId } = await registerCompany(app, { email: 'o@acme.sa', company: 'Acme' });
    const bad = await owner.patch('/tenant', { crNumber: '123', vatNumber: '1234' });
    expect(bad.status).toBe(400);
    const res = await owner
      .patch('/tenant', { name: 'Acme Logistics', crNumber: '1010123456', vatNumber: '300000000000003', settings: { repVisibility: 'all' } })
      .expect(200);
    expect(res.body).toMatchObject({ id: tenantId, name: 'Acme Logistics', crNumber: '1010123456', settings: { repVisibility: 'all' } });
    const logs = (await owner.get('/audit-logs?action=tenant.update').expect(200)).body.items;
    expect(logs).toHaveLength(1);
    expect(logs[0].before.name).toBe('Acme');
    expect(logs[0].after.name).toBe('Acme Logistics');
    expect(logs[0].actorName).toBe('Owner Acme');
  });
});

describe('territories', () => {
  it('creates, assigns members, renames, and deletes territories', async () => {
    const { client: owner } = await registerCompany(app, { email: 'o@acme.sa', company: 'Acme' });
    const { membershipId: repId } = await addMember(app, owner, 'rep@acme.sa', 'rep');
    const t = (await owner.post('/team/territories', { name: 'الوسطى', regions: ['الرياض', 'القصيم'] }).expect(201)).body;
    expect(t.regions).toEqual(['الرياض', 'القصيم']);
    const dup = await owner.post('/team/territories', { name: 'الوسطى' });
    expect(dup.body.error.code).toBe('NAME_TAKEN');

    const assigned = (await owner.put(`/team/territories/${t.id}/members`, { membershipIds: [repId, repId] }).expect(200)).body;
    expect(assigned.memberIds).toEqual([repId]);
    const bad = await owner.put(`/team/territories/${t.id}/members`, { membershipIds: ['00000000-0000-4000-8000-000000000000'] });
    expect(bad.body.error.code).toBe('INVALID_MEMBER');

    // Re-submitting the same members is a no-op (no audit entry).
    await owner.put(`/team/territories/${t.id}/members`, { membershipIds: [repId] }).expect(200);
    await owner.patch(`/team/territories/${t.id}`, { name: 'المنطقة الوسطى', regions: ['الرياض'] }).expect(200);
    // Saving unchanged fields is a no-op too.
    await owner.patch(`/team/territories/${t.id}`, { name: 'المنطقة الوسطى', regions: ['الرياض'] }).expect(200);
    expect((await owner.get('/audit-logs?action=territory.update').expect(200)).body.items).toHaveLength(1);
    const upd = (await owner.get('/audit-logs?action=territory.update').expect(200)).body.items[0];
    expect(upd.before).toEqual({ name: 'الوسطى', regions: ['الرياض', 'القصيم'], cities: [] });
    const list = (await owner.get('/team/territories').expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'المنطقة الوسطى', memberIds: [repId] });

    await owner.delete(`/team/territories/${t.id}`).expect(204);
    await owner.delete(`/team/territories/${t.id}`).expect(404);
    await owner.patch('/team/territories/not-a-uuid', { name: 'x y' }).expect(404);

    const actions = (await owner.get('/audit-logs?entityType=territory').expect(200)).body.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(['territory.delete', 'territory.update', 'territory.assign', 'territory.create']);
  });
});
