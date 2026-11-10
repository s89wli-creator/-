import { Inject, Injectable } from '@nestjs/common';
import { memberships, passwordResetTokens, setTenantContext, tenants, users } from '@rakan/db';
import { permissionsForRole, type LoginInput, type MeResponse, type RegisterInput } from '@rakan/shared';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext, RequestMeta } from '../common/auth-context';
import { generateToken, hashToken } from '../common/crypto';
import { DbService, pgConstraint, pgErrorCode } from '../common/db.service';
import { AppError, conflict } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { MailService } from './mail.service';
import { PasswordService } from './password.service';
import { SecurityService } from './security.service';
import { PlanService } from '../platform/plan.service';
import { SessionService } from './session.service';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
const RESET_TOKEN_MINUTES = 60;

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

export function makeSlug(name: string): string {
  const latin = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = randomBytes(4).toString('hex').slice(0, 6);
  return `${latin.length >= 3 ? latin : 'company'}-${suffix}`;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly security: SecurityService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly plans: PlanService,
  ) {}

  /** Self-serve sign-up: creates the user, the company, and an owner membership atomically. */
  async register(input: RegisterInput, meta: RequestMeta): Promise<{ token: string }> {
    const passwordHash = await this.passwords.hash(input.password);
    let ids: { userId: string; tenantId: string };
    try {
      ids = await this.db.platform(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ email: input.email, fullName: input.fullName, passwordHash, locale: input.locale })
          .returning({ id: users.id });
        const [tenant] = await tx
          .insert(tenants)
          .values({ name: input.companyName, slug: makeSlug(input.companyName), defaultLocale: input.locale })
          .returning({ id: tenants.id });
        await setTenantContext(tx, tenant!.id);
        await tx.insert(memberships).values({ tenantId: tenant!.id, userId: user!.id, role: 'owner' });
        await tx.$client.query('SELECT seed_crm_defaults($1)', [tenant!.id]);
        await this.plans.startTrial(tx, tenant!.id);
        await this.audit.record(tx, {
          tenantId: tenant!.id,
          actorUserId: user!.id,
          action: 'tenant.create',
          entityType: 'tenant',
          entityId: tenant!.id,
          after: { name: input.companyName, owner: input.email },
          meta,
        });
        return { userId: user!.id, tenantId: tenant!.id };
      });
    } catch (e) {
      if (pgErrorCode(e) === '23505' && pgConstraint(e) === 'users_email_key') {
        throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      }
      throw e;
    }
    await this.security.sendVerification(ids.userId, input.locale);
    return { token: await this.sessions.create(ids.userId, ids.tenantId, meta) };
  }

  /** Password step. With two-step verification on, returns a short-lived challenge instead of a session. */
  async login(input: LoginInput, meta: RequestMeta): Promise<{ token: string } | { mfaChallenge: string }> {
    const [user] = await this.db.platform((tx) => tx.select().from(users).where(eq(users.email, input.email)).limit(1));
    if (!user) {
      await this.passwords.burn(input.password);
      throw invalidCredentials();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.passwords.burn(input.password);
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked after too many failed attempts', {
        lockedUntil: user.lockedUntil.toISOString(),
      });
    }
    const ok = !user.disabledAt && (await this.passwords.verify(user.passwordHash, input.password));
    if (!ok) {
      await this.db.platform(async (tx) => {
        const [u] = await tx
          .update(users)
          .set({ failedLoginCount: sql`${users.failedLoginCount} + 1`, updatedAt: new Date() })
          .where(eq(users.id, user.id))
          .returning({ count: users.failedLoginCount });
        const locked = (u?.count ?? 0) >= MAX_FAILED_LOGINS;
        if (locked) {
          await tx
            .update(users)
            .set({ failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) })
            .where(eq(users.id, user.id));
        }
        await this.audit.record(tx, {
          tenantId: null,
          actorType: 'system',
          action: locked ? 'auth.account_locked' : 'auth.login_failed',
          entityType: 'user',
          entityId: user.id,
          meta,
        });
      });
      throw invalidCredentials();
    }

    if (user.mfaEnabledAt) {
      await this.db.platform((tx) => tx.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id)));
      return { mfaChallenge: await this.security.createChallenge(user.id) };
    }
    return { token: await this.startSession(user.id, meta, false) };
  }

  /** Second step: code from the authenticator app (or a recovery code). */
  async completeMfa(challenge: string, code: string, meta: RequestMeta): Promise<{ token: string }> {
    const userId = await this.security.completeChallenge(challenge, code, meta);
    return { token: await this.startSession(userId, meta, true) };
  }

  private async startSession(userId: string, meta: RequestMeta, mfaVerified: boolean): Promise<string> {
    const user = { id: userId };
    const activeTenantId = await this.db.platform(async (tx) => {
      const [m] = await tx
        .select({ tenantId: memberships.tenantId })
        .from(memberships)
        .where(and(eq(memberships.userId, user.id), eq(memberships.status, 'active')))
        .orderBy(asc(memberships.createdAt))
        .limit(1);
      await tx
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, user.id));
      if (m) await setTenantContext(tx, m.tenantId);
      await this.audit.record(tx, {
        tenantId: m?.tenantId ?? null,
        actorUserId: user.id,
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        meta,
      });
      return m?.tenantId ?? null;
    }, user.id);

    return this.sessions.create(user.id, activeTenantId, meta, mfaVerified);
  }

  async logout(auth: AuthContext, meta: RequestMeta): Promise<void> {
    await this.sessions.revoke(auth.sessionId);
    await this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'auth.logout',
        entityType: 'user',
        entityId: auth.userId,
        meta,
      }),
    );
  }

  async me(auth: AuthContext): Promise<MeResponse> {
    return this.db.platform(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, auth.userId)).limit(1);
      const rows = await tx
        .select({ tenantId: memberships.tenantId, tenantName: tenants.name, slug: tenants.slug, role: memberships.role, membershipId: memberships.id, settings: tenants.settings, status: tenants.status })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(and(eq(memberships.userId, auth.userId), eq(memberships.status, 'active')))
        .orderBy(asc(tenants.name));
      const active = rows.find((r) => r.tenantId === auth.tenantId);
      return {
        user: {
          id: user!.id,
          email: user!.email,
          fullName: user!.fullName,
          locale: user!.locale,
          isPlatformAdmin: user!.isPlatformAdmin,
          emailVerified: !!user!.emailVerifiedAt,
          mfaEnabled: !!user!.mfaEnabledAt,
        },
        activeTenant: active
          ? {
              id: active.tenantId,
              name: active.tenantName,
              slug: active.slug,
              role: active.role,
              permissions: [...permissionsForRole(active.role)],
              membershipId: active.membershipId,
              features: { recordingEnabled: !!(active.settings as { recordingEnabled?: boolean } | null)?.recordingEnabled },
              status: active.status,
            }
          : null,
        memberships: rows.map((r) => ({ tenantId: r.tenantId, tenantName: r.tenantName, role: r.role })),
      };
    }, auth.userId);
  }

  async switchTenant(auth: AuthContext, tenantId: string, meta: RequestMeta): Promise<string> {
    const ok = await this.db.run({ tenantId, userId: auth.userId }, async (tx) => {
      const [m] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, auth.userId), eq(memberships.status, 'active')))
        .limit(1);
      if (m) {
        await this.audit.record(tx, {
          tenantId,
          actorUserId: auth.userId,
          action: 'auth.switch_tenant',
          entityType: 'tenant',
          entityId: tenantId,
          meta,
        });
      }
      return !!m;
    });
    // Same response whether the tenant does not exist or the user is not a member.
    if (!ok) throw new AppError(404, 'NOT_FOUND', 'Company not found');
    return this.sessions.switchTenant(auth.sessionId, tenantId);
  }

  /** Always succeeds from the caller's perspective (no account enumeration). */
  async forgotPassword(email: string, locale: 'ar' | 'en', meta: RequestMeta): Promise<void> {
    const [user] = await this.db.platform((tx) => tx.select().from(users).where(eq(users.email, email)).limit(1));
    if (!user || user.disabledAt) return;
    const token = generateToken();
    await this.db.platform(async (tx) => {
      await tx.insert(passwordResetTokens).values({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_MINUTES * 60_000),
      });
      await this.audit.record(tx, {
        tenantId: null,
        actorType: 'system',
        action: 'auth.password_reset_requested',
        entityType: 'user',
        entityId: user.id,
        meta,
      });
    });
    const link = `${this.config.WEB_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;
    const ar = locale === 'ar' || user.locale === 'ar';
    await this.mail.send({
      to: user.email,
      subject: ar ? 'راكان — إعادة تعيين كلمة المرور' : 'Rakan — Reset your password',
      text: ar
        ? `مرحباً ${user.fullName}،\n\nلإعادة تعيين كلمة المرور افتح الرابط التالي (صالح لمدة ساعة):\n${link}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة.`
        : `Hello ${user.fullName},\n\nOpen this link to reset your password (valid for 1 hour):\n${link}\n\nIf you did not request this, ignore this email.`,
    });
  }

  async resetPassword(token: string, password: string, meta: RequestMeta): Promise<void> {
    const passwordHash = await this.passwords.hash(password);
    const userId = await this.db.platform(async (tx) => {
      // Atomic single-use: only one concurrent request can flip used_at.
      const [t] = await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokens.tokenHash, hashToken(token)),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date()),
          ),
        )
        .returning({ userId: passwordResetTokens.userId });
      if (!t) return null;
      await tx
        .update(users)
        .set({ passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(users.id, t.userId));
      await this.audit.record(tx, {
        tenantId: null,
        actorType: 'system',
        action: 'auth.password_reset',
        entityType: 'user',
        entityId: t.userId,
        meta,
      });
      return t.userId;
    });
    if (!userId) throw new AppError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
    await this.sessions.revokeAllForUser(userId);
  }
}
