import { Inject, Injectable } from '@nestjs/common';
import { invitations, memberships, setTenantContext, tenants, users, type Tx } from '@rakan/db';
import {
  canAssignRole, type InvitationDto, type InviteInput, type MemberDto, type SystemRole, type UpdateMemberInput,
} from '@rakan/shared';
import { and, asc, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext, RequestMeta, TenantAuthContext } from '../common/auth-context';
import { generateToken, hashToken } from '../common/crypto';
import { DbService, pgErrorCode } from '../common/db.service';
import { AppError, conflict, forbidden, notFound } from '../common/errors';
import { PlanService } from '../platform/plan.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../identity/mail.service';
import { PasswordService } from '../identity/password.service';

const INVITE_DAYS = 7;

const ROLE_LABEL_AR: Record<SystemRole, string> = {
  owner: 'مالك الشركة', manager: 'مدير مبيعات', rep: 'مندوب مبيعات', readonly: 'قراءة فقط',
};

type InvitationRow = typeof invitations.$inferSelect;
const invitationDto = (i: InvitationRow): InvitationDto => ({
  id: i.id,
  email: i.email,
  role: i.role,
  expiresAt: i.expiresAt.toISOString(),
  acceptedAt: i.acceptedAt?.toISOString() ?? null,
  revokedAt: i.revokedAt?.toISOString() ?? null,
  createdAt: i.createdAt.toISOString(),
});

export interface InvitationPreview {
  tenantName: string;
  email: string;
  role: SystemRole;
  status: 'pending' | 'expired' | 'used';
  accountExists: boolean;
}

@Injectable()
export class TeamService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly passwords: PasswordService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly plans: PlanService,
  ) {}

  // ---------------- members ----------------

  listMembers(auth: TenantAuthContext): Promise<MemberDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const rows = await tx
        .select({ m: memberships, u: users })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.tenantId, auth.tenantId))
        .orderBy(asc(users.fullName));
      return rows.map(({ m, u }) => ({
        id: m.id,
        userId: u.id,
        fullName: u.fullName,
        email: u.email,
        role: m.role,
        title: m.title,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
      }));
    });
  }

  updateMember(auth: TenantAuthContext, membershipId: string, input: UpdateMemberInput, meta: RequestMeta): Promise<MemberDto> {
    return this.db.tenant(auth, async (tx) => {
      const [target] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.tenantId, auth.tenantId), eq(memberships.id, membershipId)))
        .limit(1);
      if (!target) throw notFound('Member');

      const changesRoleOrStatus =
        (input.role !== undefined && input.role !== target.role) ||
        (input.status !== undefined && input.status !== target.status);
      if (changesRoleOrStatus) {
        if (target.id === auth.membershipId) {
          throw forbidden('You cannot change your own role or status');
        }
        // Must be allowed to manage the member's current role AND grant the new one.
        if (!canAssignRole(auth.role, target.role)) throw forbidden('You cannot manage a member with this role');
        if (input.role && !canAssignRole(auth.role, input.role)) throw forbidden('You cannot assign this role');

        const losesOwner =
          target.role === 'owner' &&
          target.status === 'active' &&
          ((input.role && input.role !== 'owner') || input.status === 'disabled');
        // Defense in depth: with the self-change rule an acting owner always remains, but this
        // invariant must hold even if role rules change later.
        if (losesOwner) {
          const others = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(
              and(
                eq(memberships.tenantId, auth.tenantId),
                eq(memberships.role, 'owner'),
                eq(memberships.status, 'active'),
                ne(memberships.id, target.id),
              ),
            )
            .limit(1);
          if (!others.length) throw conflict('LAST_OWNER', 'The company must keep at least one active owner');
        }
      } else if (target.id !== auth.membershipId && !canAssignRole(auth.role, target.role)) {
        throw forbidden('You cannot manage a member with this role');
      }

      const [after] = await tx
        .update(memberships)
        .set({
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(memberships.tenantId, auth.tenantId), eq(memberships.id, target.id)))
        .returning();
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'member.update',
        entityType: 'membership',
        entityId: target.id,
        before: { role: target.role, status: target.status, title: target.title },
        after: { role: after!.role, status: after!.status, title: after!.title },
        meta,
      });
      const [u] = await tx.select().from(users).where(eq(users.id, after!.userId)).limit(1);
      return {
        id: after!.id,
        userId: u!.id,
        fullName: u!.fullName,
        email: u!.email,
        role: after!.role,
        title: after!.title,
        status: after!.status,
        createdAt: after!.createdAt.toISOString(),
      };
    });
  }

  // ---------------- invitations ----------------

  listInvitations(auth: TenantAuthContext): Promise<InvitationDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const rows = await tx
        .select()
        .from(invitations)
        .where(and(eq(invitations.tenantId, auth.tenantId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
        .orderBy(desc(invitations.createdAt));
      return rows.map(invitationDto);
    });
  }

  async invite(auth: TenantAuthContext, input: InviteInput, meta: RequestMeta): Promise<InvitationDto> {
    if (!canAssignRole(auth.role, input.role)) throw forbidden('You cannot invite a member with this role');
    await this.plans.assertCanAddUser(auth.tenantId);
    const token = generateToken();
    const { dto, tenantName } = await this.db.tenant(auth, async (tx) => {
      const existing = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, auth.tenantId), eq(users.email, input.email)))
        .limit(1);
      if (existing.length) throw conflict('ALREADY_MEMBER', 'This person is already a member of the company');

      // Re-inviting replaces the previous pending invitation (resend).
      await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invitations.tenantId, auth.tenantId),
            eq(invitations.email, input.email),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        );
      const [inv] = await tx
        .insert(invitations)
        .values({
          tenantId: auth.tenantId,
          email: input.email,
          role: input.role,
          title: input.title ?? null,
          tokenHash: hashToken(token),
          invitedBy: auth.userId,
          expiresAt: new Date(Date.now() + INVITE_DAYS * 86400_000),
        })
        .returning();
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'invitation.create',
        entityType: 'invitation',
        entityId: inv!.id,
        after: { email: input.email, role: input.role },
        meta,
      });
      const [t] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, auth.tenantId));
      return { dto: invitationDto(inv!), tenantName: t!.name };
    });

    const link = `${this.config.WEB_ORIGIN}/invite/${encodeURIComponent(token)}`;
    await this.mail.send({
      to: input.email,
      subject: `دعوة للانضمام إلى ${tenantName} على راكان — Invitation to join ${tenantName} on Rakan`,
      text:
        `دعاك ${auth.fullName} للانضمام إلى ${tenantName} بصفة: ${ROLE_LABEL_AR[input.role]}.\n` +
        `لقبول الدعوة (صالحة ${INVITE_DAYS} أيام):\n${link}\n\n` +
        `${auth.fullName} invited you to join ${tenantName} as ${input.role}.\nAccept (valid ${INVITE_DAYS} days):\n${link}`,
    });
    return dto;
  }

  revokeInvitation(auth: TenantAuthContext, invitationId: string, meta: RequestMeta): Promise<void> {
    return this.db.tenant(auth, async (tx) => {
      const [inv] = await tx
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.tenantId, auth.tenantId),
            eq(invitations.id, invitationId),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .limit(1);
      if (!inv) throw notFound('Invitation');
      if (!canAssignRole(auth.role, inv.role)) throw forbidden('You cannot revoke this invitation');
      await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(and(eq(invitations.tenantId, auth.tenantId), eq(invitations.id, inv.id)));
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'invitation.revoke',
        entityType: 'invitation',
        entityId: inv.id,
        before: { email: inv.email, role: inv.role },
        meta,
      });
    });
  }

  private async findByToken(tx: Tx, token: string): Promise<InvitationRow | undefined> {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.tokenHash, hashToken(token))).limit(1);
    return inv;
  }

  /** Public preview for the acceptance screen. Unknown token => 404. */
  previewInvitation(token: string): Promise<InvitationPreview> {
    return this.db.run({ tenantId: null, invitationTokenHash: hashToken(token) }, async (tx) => {
      const inv = await this.findByToken(tx, token);
      if (!inv || inv.revokedAt) throw notFound('Invitation');
      const [t] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, inv.tenantId));
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.email, inv.email)).limit(1);
      return {
        tenantName: t!.name,
        email: inv.email,
        role: inv.role,
        status: inv.acceptedAt ? 'used' : inv.expiresAt <= new Date() ? 'expired' : 'pending',
        accountExists: !!u,
      };
    });
  }

  /**
   * Accepts an invitation.
   *  - New email: creates the account (fullName + password required).
   *  - Existing account: caller must be signed in as that same email.
   * Returns the user and tenant to start/switch the session to.
   */
  async acceptInvitation(
    input: { token: string; fullName?: string; password?: string },
    auth: AuthContext | undefined,
    meta: RequestMeta,
  ): Promise<{ userId: string; tenantId: string; createdAccount: boolean }> {
    const tokenHash = hashToken(input.token);
    const passwordHash = input.password ? await this.passwords.hash(input.password) : null;
    try {
      return await this.db.run({ tenantId: null, invitationTokenHash: tokenHash }, async (tx) => {
        const inv = await this.findByToken(tx, input.token);
        if (!inv || inv.revokedAt) throw notFound('Invitation');
        if (inv.acceptedAt) throw new AppError(410, 'INVITATION_USED', 'This invitation has already been used');
        if (inv.expiresAt <= new Date()) throw new AppError(410, 'INVITATION_EXPIRED', 'This invitation has expired');

        const [existing] = await tx.select().from(users).where(eq(users.email, inv.email)).limit(1);
        let userId: string;
        let createdAccount = false;
        if (existing) {
          if (!auth || auth.userId !== existing.id) {
            throw new AppError(401, 'LOGIN_REQUIRED', 'Sign in with the invited email to accept this invitation');
          }
          if (existing.disabledAt) throw forbidden('Account disabled');
          userId = existing.id;
        } else {
          if (auth) throw forbidden('You are signed in with a different account');
          if (!input.fullName || !passwordHash) {
            throw new AppError(400, 'VALIDATION_ERROR', 'Full name and password are required to create the account');
          }
          const [u] = await tx
            .insert(users)
            .values({ email: inv.email, fullName: input.fullName, passwordHash, emailVerifiedAt: new Date() })
            .returning({ id: users.id });
          userId = u!.id;
          createdAccount = true;
        }

        await setTenantContext(tx, inv.tenantId);
        // Atomic single use.
        const claimed = await tx
          .update(invitations)
          .set({ acceptedAt: new Date() })
          .where(and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
          .returning({ id: invitations.id });
        if (!claimed.length) throw new AppError(410, 'INVITATION_USED', 'This invitation has already been used');

        const [m] = await tx
          .insert(memberships)
          .values({ tenantId: inv.tenantId, userId, role: inv.role, title: inv.title })
          .returning({ id: memberships.id });
        await this.audit.record(tx, {
          tenantId: inv.tenantId,
          actorUserId: userId,
          action: 'invitation.accept',
          entityType: 'membership',
          entityId: m!.id,
          after: { email: inv.email, role: inv.role, createdAccount },
          meta,
        });
        return { userId, tenantId: inv.tenantId, createdAccount };
      });
    } catch (e) {
      if (pgErrorCode(e) === '23505') throw conflict('ALREADY_MEMBER', 'You are already a member of this company');
      throw e;
    }
  }
}
