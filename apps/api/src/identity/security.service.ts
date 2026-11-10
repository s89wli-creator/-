import { Inject, Injectable } from '@nestjs/common';
import { emailVerificationTokens, mfaChallenges, sessions, users } from '@rakan/db';
import type { SecurityDto } from '@rakan/shared';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import QRCode from 'qrcode';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext, RequestMeta } from '../common/auth-context';
import { generateToken, hashToken } from '../common/crypto';
import { DbService } from '../common/db.service';
import { AppError, conflict, notFound } from '../common/errors';
import { FieldCryptoService } from '../common/field-crypto.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from './mail.service';
import { generateRecoveryCodes, generateSecret, otpauthUri, verifyTotp } from './totp';

/** MFA secrets are not tenant data: they are encrypted under a dedicated key namespace. */
const MFA_KEY_NS = 'platform:mfa';
const CHALLENGE_MINUTES = 5;
const MAX_CHALLENGE_ATTEMPTS = 5;
const EMAIL_TOKEN_HOURS = 48;

@Injectable()
export class SecurityService {
  constructor(
    private readonly db: DbService,
    private readonly crypto: FieldCryptoService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async user(userId: string) {
    const [u] = await this.db.platform((tx) => tx.select().from(users).where(eq(users.id, userId)).limit(1));
    if (!u) throw notFound('User');
    return u;
  }

  // ---------------- MFA enrolment ----------------

  /** Starts enrolment: stores a new (not yet active) secret and returns the QR code to scan. */
  async setup(auth: AuthContext): Promise<{ qr: string; secret: string; uri: string }> {
    const u = await this.user(auth.userId);
    if (u.mfaEnabledAt) throw conflict('MFA_ALREADY_ENABLED', 'Two-step verification is already on');
    const secret = generateSecret();
    await this.db.platform((tx) =>
      tx.update(users).set({ mfaSecretEnc: this.crypto.encrypt(MFA_KEY_NS, secret), updatedAt: new Date() }).where(eq(users.id, u.id)),
    );
    const uri = otpauthUri(secret, u.email);
    return { qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }), secret, uri };
  }

  /** Confirms enrolment with a code from the app; returns one-time recovery codes. */
  async enable(auth: AuthContext, code: string, meta: RequestMeta): Promise<{ recoveryCodes: string[] }> {
    const u = await this.user(auth.userId);
    if (u.mfaEnabledAt) throw conflict('MFA_ALREADY_ENABLED', 'Two-step verification is already on');
    const secret = this.crypto.decrypt(MFA_KEY_NS, u.mfaSecretEnc);
    if (!secret) throw new AppError(400, 'MFA_SETUP_REQUIRED', 'Start setup first');
    if (!verifyTotp(secret, code)) throw new AppError(400, 'MFA_INVALID_CODE', 'The code is incorrect or expired');
    const codes = generateRecoveryCodes();
    await this.db.platform(async (tx) => {
      await tx
        .update(users)
        .set({ mfaEnabledAt: new Date(), mfaRecoveryHashes: codes.map(hashToken), updatedAt: new Date() })
        .where(eq(users.id, u.id));
      await tx.update(sessions).set({ mfaVerified: true }).where(eq(sessions.id, auth.sessionId));
      await this.audit.record(tx, { tenantId: null, actorUserId: u.id, action: 'auth.mfa_enabled', entityType: 'user', entityId: u.id, meta });
    }, u.id);
    return { recoveryCodes: codes };
  }

  async disable(auth: AuthContext, code: string, meta: RequestMeta): Promise<void> {
    const u = await this.user(auth.userId);
    if (!u.mfaEnabledAt) throw new AppError(400, 'MFA_NOT_ENABLED', 'Two-step verification is off');
    if (!this.checkCode(u, code).ok) throw new AppError(400, 'MFA_INVALID_CODE', 'The code is incorrect or expired');
    await this.db.platform(async (tx) => {
      await tx.update(users).set({ mfaEnabledAt: null, mfaSecretEnc: null, mfaRecoveryHashes: [], updatedAt: new Date() }).where(eq(users.id, u.id));
      await this.audit.record(tx, { tenantId: null, actorUserId: u.id, action: 'auth.mfa_disabled', entityType: 'user', entityId: u.id, meta });
    }, u.id);
  }

  /** A 6-digit app code, or an unused recovery code (which is then consumed). */
  checkCode(u: typeof users.$inferSelect, code: string): { ok: boolean; recoveryHash?: string } {
    const secret = this.crypto.decrypt(MFA_KEY_NS, u.mfaSecretEnc);
    if (secret && verifyTotp(secret, code)) return { ok: true };
    const h = hashToken(code.trim().toLowerCase());
    if (u.mfaRecoveryHashes.includes(h)) return { ok: true, recoveryHash: h };
    return { ok: false };
  }

  // ---------------- MFA at sign-in ----------------

  async createChallenge(userId: string): Promise<string> {
    const token = generateToken();
    await this.db.platform((tx) =>
      tx.insert(mfaChallenges).values({ userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60_000) }),
    );
    return token;
  }

  /** Verifies the second step. Returns the user id; each challenge allows 5 attempts and one success. */
  async completeChallenge(challenge: string, code: string, meta: RequestMeta): Promise<string> {
    // Errors are raised after the transaction commits so failed attempts are persisted.
    const outcome = await this.db.platform(async (tx): Promise<{ userId: string } | { error: 'expired' | 'invalid' }> => {
      const [c] = await tx
        .select()
        .from(mfaChallenges)
        .where(and(eq(mfaChallenges.tokenHash, hashToken(challenge)), isNull(mfaChallenges.usedAt), gt(mfaChallenges.expiresAt, new Date())))
        .limit(1);
      if (!c || c.attempts >= MAX_CHALLENGE_ATTEMPTS) return { error: 'expired' };
      const [u] = await tx.select().from(users).where(eq(users.id, c.userId)).limit(1);
      const result = u ? this.checkCode(u, code) : { ok: false };
      if (!u || !result.ok) {
        await tx.update(mfaChallenges).set({ attempts: c.attempts + 1 }).where(eq(mfaChallenges.id, c.id));
        await this.audit.record(tx, { tenantId: null, actorType: 'system', action: 'auth.mfa_failed', entityType: 'user', entityId: c.userId, meta });
        return { error: 'invalid' };
      }
      await tx.update(mfaChallenges).set({ usedAt: new Date() }).where(eq(mfaChallenges.id, c.id));
      if (result.recoveryHash) {
        await tx
          .update(users)
          .set({ mfaRecoveryHashes: u.mfaRecoveryHashes.filter((x) => x !== result.recoveryHash) })
          .where(eq(users.id, u.id));
        await this.audit.record(tx, { tenantId: null, actorUserId: u.id, action: 'auth.mfa_recovery_code_used', entityType: 'user', entityId: u.id, meta });
      }
      return { userId: u.id };
    });
    if ('error' in outcome) {
      if (outcome.error === 'expired') throw new AppError(401, 'MFA_CHALLENGE_EXPIRED', 'Sign in again');
      throw new AppError(400, 'MFA_INVALID_CODE', 'The code is incorrect or expired');
    }
    return outcome.userId;
  }

  // ---------------- email verification ----------------

  async sendVerification(userId: string, locale: 'ar' | 'en' = 'ar'): Promise<void> {
    const u = await this.user(userId);
    if (u.emailVerifiedAt) return;
    const token = generateToken();
    await this.db.platform((tx) =>
      tx.insert(emailVerificationTokens).values({ userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + EMAIL_TOKEN_HOURS * 3600_000) }),
    );
    const link = `${this.config.WEB_ORIGIN}/verify-email?token=${encodeURIComponent(token)}`;
    await this.mail.send({
      to: u.email,
      subject: locale === 'ar' ? 'راكان — تأكيد بريدك الإلكتروني' : 'Rakan — Confirm your email',
      text:
        locale === 'ar'
          ? `مرحباً ${u.fullName}،\n\nلتأكيد بريدك الإلكتروني افتح الرابط (صالح 48 ساعة):\n${link}`
          : `Hello ${u.fullName},\n\nConfirm your email (valid 48 hours):\n${link}`,
    });
  }

  async verifyEmail(token: string, meta: RequestMeta): Promise<void> {
    const ok = await this.db.platform(async (tx) => {
      const [t] = await tx
        .update(emailVerificationTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(emailVerificationTokens.tokenHash, hashToken(token)), isNull(emailVerificationTokens.usedAt), gt(emailVerificationTokens.expiresAt, new Date())))
        .returning({ userId: emailVerificationTokens.userId });
      if (!t) return false;
      await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, t.userId));
      await this.audit.record(tx, { tenantId: null, actorUserId: t.userId, action: 'auth.email_verified', entityType: 'user', entityId: t.userId, meta });
      return true;
    });
    if (!ok) throw new AppError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
  }

  // ---------------- sessions ----------------

  async overview(auth: AuthContext): Promise<SecurityDto> {
    const u = await this.user(auth.userId);
    const rows = await this.db.platform((tx) =>
      tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, auth.userId), isNull(sessions.revokedAt), gt(sessions.idleExpiresAt, new Date())))
        .orderBy(desc(sessions.lastSeenAt)),
    );
    return {
      mfaEnabled: !!u.mfaEnabledAt,
      emailVerified: !!u.emailVerifiedAt,
      sessions: rows.map((s) => ({
        id: s.id, current: s.id === auth.sessionId, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(), mfaVerified: s.mfaVerified,
      })),
    };
  }

  /** Users can end only their own sessions (anything else is "not found"). */
  async revokeSession(auth: AuthContext, sessionId: string, meta: RequestMeta): Promise<void> {
    const done = await this.db.platform(async (tx) => {
      const [s] = await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, auth.userId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      if (s) await this.audit.record(tx, { tenantId: null, actorUserId: auth.userId, action: 'auth.session_revoked', entityType: 'session', entityId: s.id, meta });
      return !!s;
    });
    if (!done) throw notFound('Session');
  }
}
