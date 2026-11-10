/**
 * Permission matrix — single source of truth for API guards and UI.
 * System roles resolve their permissions from this file (not from the DB),
 * so a code review is required to change what a built-in role can do.
 */
export const PERMISSIONS = [
  'tenant.settings.read',
  'tenant.settings.update',
  'team.member.read',
  'team.member.invite',
  'team.member.update',
  'team.territory.read',
  'team.territory.manage',
  'audit.read',
  'billing.manage',
  'crm.settings.manage',
  'crm.account.read',
  'crm.account.write',
  'crm.account.delete',
  'crm.import',
  'crm.export',
  'crm.opportunity.read',
  'crm.opportunity.write',
  'crm.task.read',
  'crm.task.write',
  'crm.visit.read',
  'crm.visit.write',
  'reports.read',
  'brain.read',
  'brain.manage',
  'ai.use',
  'ai.manage',
  'ai.runs.read',
  'approvals.decide',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLES = ['owner', 'manager', 'rep', 'readonly'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const ROLE_PERMISSIONS: Record<SystemRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  manager: [
    'tenant.settings.read',
    'team.member.read',
    'team.member.invite',
    'team.member.update',
    'team.territory.read',
    'team.territory.manage',
    'audit.read',
    'crm.settings.manage',
    'crm.account.read',
    'crm.account.write',
    'crm.account.delete',
    'crm.import',
    'crm.export',
    'crm.opportunity.read',
    'crm.opportunity.write',
    'crm.task.read',
    'crm.task.write',
    'crm.visit.read',
    'crm.visit.write',
    'reports.read',
    'brain.read',
    'brain.manage',
    'ai.use',
    'ai.runs.read',
    'approvals.decide',
  ],
  // Reps work only on records assigned to them (enforced per record in the API; see RecordScope).
  rep: [
    'tenant.settings.read',
    'crm.account.read',
    'crm.account.write',
    'crm.opportunity.read',
    'crm.opportunity.write',
    'crm.task.read',
    'crm.task.write',
    'crm.visit.read',
    'crm.visit.write',
    'brain.read',
    'ai.use',
  ],
  readonly: [
    'tenant.settings.read',
    'team.member.read',
    'team.territory.read',
    'crm.account.read',
    'crm.opportunity.read',
    'crm.task.read',
    'crm.visit.read',
    'reports.read',
    'brain.read',
  ],
};

/** Roles a given role is allowed to grant (invite into / change to). */
export const ASSIGNABLE_ROLES: Record<SystemRole, readonly SystemRole[]> = {
  owner: ['owner', 'manager', 'rep', 'readonly'],
  manager: ['manager', 'rep', 'readonly'],
  rep: [],
  readonly: [],
};

export function permissionsForRole(role: string): readonly Permission[] {
  return (ROLE_PERMISSIONS as Record<string, readonly Permission[]>)[role] ?? [];
}

export function hasPermission(role: string, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

export function canAssignRole(actorRole: string, targetRole: string): boolean {
  const allowed = (ASSIGNABLE_ROLES as Record<string, readonly string[]>)[actorRole] ?? [];
  return allowed.includes(targetRole);
}
