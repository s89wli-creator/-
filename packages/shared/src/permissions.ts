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
  ],
  rep: ['tenant.settings.read'],
  readonly: ['tenant.settings.read', 'team.member.read', 'team.territory.read'],
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
