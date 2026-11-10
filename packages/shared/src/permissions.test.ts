import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, canAssignRole, hasPermission } from './permissions';

describe('permission matrix', () => {
  it('owner has every permission', () => {
    for (const p of PERMISSIONS) expect(hasPermission('owner', p)).toBe(true);
  });
  it('manager cannot manage billing or update company settings', () => {
    expect(hasPermission('manager', 'billing.manage')).toBe(false);
    expect(hasPermission('manager', 'tenant.settings.update')).toBe(false);
  });
  it('rep cannot read team, audit, or invite', () => {
    expect(hasPermission('rep', 'team.member.read')).toBe(false);
    expect(hasPermission('rep', 'audit.read')).toBe(false);
    expect(hasPermission('rep', 'team.member.invite')).toBe(false);
  });
  it('readonly has no write permission', () => {
    const writes = ROLE_PERMISSIONS.readonly.filter((p) => /(update|invite|manage)$/.test(p));
    expect(writes).toEqual([]);
  });
  it('rep cannot import, export, delete, manage CRM settings or read reports', () => {
    for (const p of ['crm.import', 'crm.export', 'crm.account.delete', 'crm.settings.manage', 'reports.read'] as const) {
      expect(hasPermission('rep', p), p).toBe(false);
    }
    expect(hasPermission('rep', 'crm.visit.write')).toBe(true);
  });
  it('only owner manages AI budget; reps use AI but cannot approve or edit the Sales Brain', () => {
    expect(hasPermission('owner', 'ai.manage')).toBe(true);
    expect(hasPermission('manager', 'ai.manage')).toBe(false);
    expect(hasPermission('rep', 'ai.use')).toBe(true);
    expect(hasPermission('rep', 'approvals.decide')).toBe(false);
    expect(hasPermission('rep', 'brain.manage')).toBe(false);
    expect(hasPermission('readonly', 'ai.use')).toBe(false);
  });
  it('unknown role has nothing', () => {
    expect(hasPermission('superhacker', 'audit.read')).toBe(false);
  });
  it('only owner can grant owner; manager can grant manager and below', () => {
    expect(canAssignRole('owner', 'owner')).toBe(true);
    expect(canAssignRole('manager', 'owner')).toBe(false);
    expect(canAssignRole('manager', 'rep')).toBe(true);
    expect(canAssignRole('rep', 'rep')).toBe(false);
  });
});
