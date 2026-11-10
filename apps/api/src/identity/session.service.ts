import { Inject, Injectable } from '@nestjs/common';
import { memberships, sessions, tenants, users } from '@rakan/db';
import { permissionsForRole } from '@rakan/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext, RequestMeta } from '../common/auth-context';
import { SESSION_COOKIE } from '../common/cookies';
import { generateToken, hashToken } from '../common/crypto';
import { DbService } from '../common/db.service';

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class SessionService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private idleExpiry(): Date {
    return new Date(Date.now() + this.config.SESSION_IDLE_HOURS * 3600_000);
  }

  async create(userId: string, activeTenantId: string | null, meta: RequestMeta, mfaVerified = false): Promise<string> {
    const token = generateToken();
    await this.db.platform((tx) =>
      tx.insert(sessions).values({
        userId,
        tokenHash: hashToken(token),
        activeTenantId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        idleExpiresAt: this.idleExpiry(),
        mfaVerified,
        absoluteExpiresAt: new Date(Date.now() + this.config.SESSION_ABSOLUTE_DAYS * 86400_000),
      }),
    );
    return token;
  }

  /** Changes active tenant and rotates the token (privilege change => new session id). */
  async switchTenant(sessionId: string, tenantId: string): Promise<string> {
    const token = generateToken();
    await this.db.platform((tx) =>
      tx.update(sessions).set({ activeTenantId: tenantId, tokenHash: hashToken(token) }).where(eq(sessions.id, sessionId)),
    );
    return token;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.platform((tx) => tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId)));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.platform((tx) =>
      tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))),
    );
  }

  setCookie(res: Response, token: string): void {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.COOKIE_SECURE,
      path: '/',
      maxAge: this.config.SESSION_ABSOLUTE_DAYS * 86400_000,
    });
  }

  clearCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  /** Resolves a session token to an AuthContext, or null if invalid/expired/revoked. */
  async resolve(token: string): Promise<AuthContext | null> {
    if (token.length > 200) return null;
    const now = new Date();
    const row = await this.db.platform(async (tx) => {
      const [r] = await tx
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.tokenHash, hashToken(token)))
        .limit(1);
      return r;
    });
    if (!row) return null;
    const { session, user } = row;
    if (session.revokedAt || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now || user.disabledAt) {
      return null;
    }

    let membership: { id: string; role: NonNullable<AuthContext['role']>; tenantStatus: string } | undefined;
    if (session.activeTenantId) {
      membership = await this.db.run({ tenantId: session.activeTenantId, userId: user.id }, async (tx) => {
        const [m] = await tx
          .select({ id: memberships.id, role: memberships.role, tenantStatus: tenants.status })
          .from(memberships)
          .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
          .where(
            and(
              eq(memberships.tenantId, session.activeTenantId!),
              eq(memberships.userId, user.id),
              eq(memberships.status, 'active'),
            ),
          )
          .limit(1);
        return m;
      });
    }

    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.platform((tx) =>
        tx
          .update(sessions)
          .set({ lastSeenAt: now, idleExpiresAt: this.idleExpiry() })
          .where(eq(sessions.id, session.id)),
      );
    }

    return {
      userId: user.id,
      sessionId: session.id,
      email: user.email,
      fullName: user.fullName,
      tenantId: membership ? session.activeTenantId : null,
      membershipId: membership?.id ?? null,
      role: membership?.role ?? null,
      permissions: membership ? permissionsForRole(membership.role) : [],
      isPlatformAdmin: user.isPlatformAdmin,
      mfaSession: !!user.mfaEnabledAt && session.mfaVerified,
      tenantStatus: membership?.tenantStatus ?? null,
    };
  }
}
