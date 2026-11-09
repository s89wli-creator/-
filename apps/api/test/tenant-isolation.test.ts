import type { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC, PERMISSION, TENANT_ISOLATION_EXEMPT } from '../src/common/decorators';
import { crmProbes, createCrmFixtures, type CrmFixtures } from './crm-probes';
import { addMember, ownerQuery, registerCompany, resetDb, startApp, type TestClient } from './helpers';

/**
 * Company A's owner attempts every tenant-scoped operation against Company B's resources.
 * Expected: 404 (existence is not revealed) and B's data is unchanged.
 */

let app: INestApplication;
let a: TestClient;
let b: TestClient;
let tenantA: string;
let tenantB: string;
const B: { memberId: string; territoryId: string; invitationId: string } = { memberId: '', territoryId: '', invitationId: '' };
let crm: CrmFixtures;

beforeAll(async () => {
  app = await startApp();
  await resetDb();
  ({ client: a, tenantId: tenantA } = await registerCompany(app, { email: 'owner@a.sa', company: 'Company A' }));
  ({ client: b, tenantId: tenantB } = await registerCompany(app, { email: 'owner@b.sa', company: 'Company B' }));
  await addMember(app, a, 'rep@a.sa', 'rep');
  B.memberId = (await addMember(app, b, 'rep@b.sa', 'rep')).membershipId;
  B.territoryId = (await b.post('/team/territories', { name: 'منطقة ب' }).expect(201)).body.id;
  B.invitationId = (await b.post('/team/invitations', { email: 'pending@b.sa', role: 'rep' }).expect(201)).body.id;
  crm = await createCrmFixtures(a, b);
});
afterAll(async () => app.close());

/** Every tenant-scoped route must be listed here with a cross-tenant probe. */
const PROBES: Record<string, () => Promise<void>> = {
  ...crmProbes(() => crm),
  'GET /api/tenant': async () => {
    const res = await a.get('/tenant').expect(200);
    expect(res.body.id).toBe(tenantA);
    expect(JSON.stringify(res.body)).not.toContain(tenantB);
  },
  'PATCH /api/tenant': async () => {
    // There is no way to address another tenant: the target is always the caller's active tenant.
    await a.patch('/tenant', { name: 'Company A2', id: tenantB } as object).expect(200);
    const [row] = await ownerQuery<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [tenantB]);
    expect(row!.name).toBe('Company B');
  },
  'GET /api/team/members': async () => {
    const emails = ((await a.get('/team/members').expect(200)).body as { email: string }[]).map((m) => m.email);
    expect(emails.sort()).toEqual(['owner@a.sa', 'rep@a.sa']);
  },
  'PATCH /api/team/members/:id': async () => {
    const res = await a.patch(`/team/members/${B.memberId}`, { role: 'manager', status: 'disabled' });
    expect(res.status).toBe(404);
    const [m] = await ownerQuery<{ role: string; status: string }>('SELECT role, status FROM memberships WHERE id = $1', [B.memberId]);
    expect(m).toEqual({ role: 'rep', status: 'active' });
  },
  'GET /api/team/invitations': async () => {
    const emails = ((await a.get('/team/invitations').expect(200)).body as { email: string }[]).map((i) => i.email);
    expect(emails).not.toContain('pending@b.sa');
  },
  'POST /api/team/invitations': async () => {
    // Inviting always targets the caller's tenant; verify the invitation did not land in B.
    await a.post('/team/invitations', { email: 'pending@b.sa', role: 'rep' }).expect(201);
    const rows = await ownerQuery<{ tenant_id: string }>(
      `SELECT tenant_id FROM invitations WHERE email = 'pending@b.sa' AND revoked_at IS NULL ORDER BY created_at`,
    );
    expect(rows.map((r) => r.tenant_id).sort()).toEqual([tenantA, tenantB].sort());
  },
  'DELETE /api/team/invitations/:id': async () => {
    await a.delete(`/team/invitations/${B.invitationId}`).expect(404);
    const [inv] = await ownerQuery<{ revoked_at: Date | null }>('SELECT revoked_at FROM invitations WHERE id = $1', [B.invitationId]);
    expect(inv!.revoked_at).toBeNull();
  },
  'GET /api/team/territories': async () => {
    const names = ((await a.get('/team/territories').expect(200)).body as { name: string }[]).map((t) => t.name);
    expect(names).not.toContain('منطقة ب');
  },
  'POST /api/team/territories': async () => {
    const t = (await a.post('/team/territories', { name: 'منطقة ب', tenantId: tenantB } as object).expect(201)).body;
    const [row] = await ownerQuery<{ tenant_id: string }>('SELECT tenant_id FROM territories WHERE id = $1', [t.id]);
    expect(row!.tenant_id).toBe(tenantA);
  },
  'PATCH /api/team/territories/:id': async () => {
    await a.patch(`/team/territories/${B.territoryId}`, { name: 'hijacked' }).expect(404);
    const [row] = await ownerQuery<{ name: string }>('SELECT name FROM territories WHERE id = $1', [B.territoryId]);
    expect(row!.name).toBe('منطقة ب');
  },
  'DELETE /api/team/territories/:id': async () => {
    await a.delete(`/team/territories/${B.territoryId}`).expect(404);
    expect(await ownerQuery('SELECT 1 FROM territories WHERE id = $1', [B.territoryId])).toHaveLength(1);
  },
  'PUT /api/team/territories/:id/members': async () => {
    await a.put(`/team/territories/${B.territoryId}/members`, { membershipIds: [] }).expect(404);
    // Assigning B's member to A's own territory is rejected by the composite FK.
    const own = (await a.post('/team/territories', { name: 'منطقة أ' }).expect(201)).body.id;
    const res = await a.put(`/team/territories/${own}/members`, { membershipIds: [B.memberId] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MEMBER');
  },
  'GET /api/audit-logs': async () => {
    const items = (await a.get('/audit-logs?limit=200').expect(200)).body.items as { entityId: string | null; after: unknown }[];
    expect(items.length).toBeGreaterThan(0);
    const blob = JSON.stringify(items);
    expect(blob).not.toContain('owner@b.sa');
    expect(blob).not.toContain(B.territoryId);
    const filtered = (await a.get(`/audit-logs?actorUserId=${(await b.get('/auth/me')).body.user.id}`).expect(200)).body.items;
    expect(filtered).toEqual([]);
  },
};

describe('tenant isolation (company A vs company B)', () => {
  for (const [route, probe] of Object.entries(PROBES)) {
    it(route, probe);
  }

  it('switching to a company you do not belong to returns 404', async () => {
    const res = await a.post('/auth/switch-tenant', { tenantId: tenantB });
    expect(res.status).toBe(404);
    expect((await a.get('/auth/me')).body.activeTenant.id).toBe(tenantA);
  });

  it('/auth/me lists only own memberships', async () => {
    const me = (await a.get('/auth/me').expect(200)).body;
    expect(me.memberships.map((m: { tenantId: string }) => m.tenantId)).toEqual([tenantA]);
  });

  it('every route is public, permission-guarded, or explicitly exempt — and every guarded route has a probe', () => {
    const routes: { key: string; kind: 'public' | 'guarded' | 'exempt' | 'UNCLASSIFIED' }[] = [];
    for (const mod of app.get(ModulesContainer).values()) {
      for (const wrapper of mod.controllers.values()) {
        const cls = wrapper.metatype as new (...args: unknown[]) => unknown;
        if (!cls) continue;
        const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '').replace(/^\/|\/$/g, '');
        for (const name of Object.getOwnPropertyNames(cls.prototype)) {
          const handler = cls.prototype[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          const path = Reflect.getMetadata(PATH_METADATA, handler);
          const method = Reflect.getMetadata(METHOD_METADATA, handler);
          if (path === undefined || method === undefined) continue;
          const sub = String(path).replace(/^\/|\/$/g, '');
          const key = `${RequestMethod[method]} /api/${[base, sub].filter(Boolean).join('/')}`;
          const meta = (k: string) => Reflect.getMetadata(k, handler) ?? Reflect.getMetadata(k, cls);
          const kind = meta(PERMISSION) ? 'guarded' : meta(IS_PUBLIC) ? 'public' : meta(TENANT_ISOLATION_EXEMPT) ? 'exempt' : 'UNCLASSIFIED';
          routes.push({ key, kind });
        }
      }
    }
    expect(routes.length).toBeGreaterThan(15);
    expect(routes.filter((r) => r.kind === 'UNCLASSIFIED').map((r) => r.key)).toEqual([]);
    const guarded = routes.filter((r) => r.kind === 'guarded').map((r) => r.key).sort();
    expect(guarded).toEqual(Object.keys(PROBES).sort());
  });
});
