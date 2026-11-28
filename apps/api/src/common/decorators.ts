import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@rakan/shared';
import type { Request } from 'express';
import type { AuthContext, RequestMeta } from './auth-context';

export const IS_PUBLIC = 'rakan:isPublic';
export const PERMISSION = 'rakan:permission';
export const TENANT_ISOLATION_EXEMPT = 'rakan:tenantIsolationExempt';
export const AUTH_RATE_LIMITED = 'rakan:authRateLimited';
export const PLATFORM_ADMIN = 'rakan:platformAdmin';

/** Applies the strict `auth` throttler (AUTH_RATE_LIMIT_PER_MINUTE per IP) to credential endpoints. */
export const AuthRateLimited = () => SetMetadata(AUTH_RATE_LIMITED, true);
/** The route stays open to a suspended company (paying its subscription). */
export const ALLOW_SUSPENDED = 'rakan:allowSuspended';
export const AllowWhenSuspended = () => SetMetadata(ALLOW_SUSPENDED, true);

/** Route does not require a session (a session is still attached if present). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Server-to-server notification from a provider (no browser, no cookies): skips the CSRF check.
 * Only for @Public endpoints that verify their own signature over the raw body.
 */
export const SIGNED_WEBHOOK = 'rakan:signedWebhook';
export const SignedWebhook = () => SetMetadata(SIGNED_WEBHOOK, true);

/** Route requires an active tenant membership with this permission. */
/** Platform console routes (cross-company aggregates). Requires a platform operator; see PermissionsGuard. */
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ADMIN, true);

export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION, permission);

/**
 * Marks an authenticated route that touches no tenant-owned data by id (e.g. /auth/me).
 * Every route must be either Public, permission-guarded, or explicitly exempt — enforced by a test.
 */
export const TenantIsolationExempt = (reason: string) => SetMetadata(TENANT_ISOLATION_EXEMPT, reason);

export type RakanRequest = Request & { auth?: AuthContext; id?: string };

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<RakanRequest>().auth;
});

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<RakanRequest>();
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
    requestId: (req.id as string | undefined) ?? null,
  };
});
