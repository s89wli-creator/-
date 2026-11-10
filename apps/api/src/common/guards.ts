import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@rakan/shared';
import { SessionService } from '../identity/session.service';
import { SESSION_COOKIE } from './cookies';
import { APP_CONFIG, type AppConfig } from '../config';
import { IS_PUBLIC, PERMISSION, PLATFORM_ADMIN, type RakanRequest } from './decorators';
import { AppError } from './errors';

/**
 * Global guard #1: resolves the session cookie into req.auth (membership and role are
 * re-read from the DB on every request, so disabling a member or changing a role takes
 * effect immediately). Non-public routes require a valid session.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RakanRequest>();
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token) req.auth = (await this.sessions.resolve(token)) ?? undefined;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    if (!req.auth) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required');
    return true;
  }
}

/**
 * Global guard #2: enforces @RequirePermission (which implies an active, non-suspended company)
 * and @PlatformAdminOnly (platform operator, with two-step verification when required).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN, [context.getHandler(), context.getClass()])) {
      const auth = context.switchToHttp().getRequest<RakanRequest>().auth;
      if (!auth) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required');
      if (!auth.isPlatformAdmin) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
      if (this.config.PLATFORM_ADMIN_REQUIRE_MFA && !auth.mfaSession) {
        throw new AppError(403, 'PLATFORM_MFA_REQUIRED', 'Turn on two-step verification to use the platform console');
      }
      return true;
    }
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) return true;
    const auth = context.switchToHttp().getRequest<RakanRequest>().auth;
    if (!auth) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required');
    if (!auth.tenantId) throw new AppError(403, 'NO_ACTIVE_TENANT', 'No active company selected');
    if (auth.tenantStatus === 'suspended' || auth.tenantStatus === 'cancelled') {
      throw new AppError(403, 'TENANT_SUSPENDED', 'This company account is suspended');
    }
    if (!auth.permissions.includes(permission)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
    }
    return true;
  }
}
