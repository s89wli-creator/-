import { Injectable, OnModuleInit } from '@nestjs/common';
import { contacts, meetingInsights, messageDrafts, visits, type Tx } from '@rakan/db';
import type { MessageDraftDto } from '@rakan/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import * as z from 'zod/v4';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, notFound } from '../common/errors';
import { FieldCryptoService } from '../common/field-crypto.service';
import { AccountsService } from '../crm/accounts.service';
import { ActivityService } from '../crm/activity.service';
import { ScopeService } from '../crm/scope';
import { MailService } from '../identity/mail.service';
import { BrainService } from './brain.service';
import { accountGrounding, brainGrounding, merge } from './context';
import { BASE_RULES, findForbidden, untrusted } from './guards';
import { AiRuntimeService } from './runtime.service';
import { ToolGatewayService } from './tool-gateway.service';

const followUpSchema = z.object({
  subject: z.string().nullable(),
  body: z.string(),
  claims: z
    .array(z.object({ text: z.string(), source: z.string() }))
    .describe('Every product, price, discount or commitment statement in the body with its brain:/doc: reference'),
});

type DraftRow = typeof messageDrafts.$inferSelect;
type SendPayload = { draftId: string; contactId: string; channel: 'email' | 'whatsapp'; subject: string | null; body: string };

/** Saudi mobile to international digits for wa.me links. */
export function waNumber(phone: string): string | null {
  const d = phone.replace(/\D/g, '');
  if (/^9665\d{8}$/.test(d)) return d;
  if (/^05\d{8}$/.test(d)) return '966' + d.slice(1);
  if (/^5\d{8}$/.test(d)) return '966' + d;
  return d.length >= 8 ? d : null;
}

/**
 * Follow-up agent and the approval-gated sending tools.
 * Nothing leaves the company without an approved request; DNC is checked when drafting, submitting and sending.
 */
@Injectable()
export class MessagingService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly runtime: AiRuntimeService,
    private readonly brain: BrainService,
    private readonly gateway: ToolGatewayService,
    private readonly scopes: ScopeService,
    private readonly accountsSvc: AccountsService,
    private readonly activity: ActivityService,
    private readonly crypto: FieldCryptoService,
    private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    const send = (channel: 'email' | 'whatsapp') => ({
      name: channel === 'email' ? 'send_email' : 'share_whatsapp',
      actionType: 'send_message',
      risk: 'EXTERNAL' as const,
      execute: (auth: TenantAuthContext, p: SendPayload) => this.executeSend(auth, p),
      onRejected: (auth: TenantAuthContext, p: SendPayload) => this.onRejected(auth, p),
    });
    this.gateway.register(send('email'));
    this.gateway.register(send('whatsapp'));
  }

  private async loadContact(tx: Tx, auth: TenantAuthContext, contactId: string, write: boolean) {
    const [c] = await tx.select().from(contacts).where(and(eq(contacts.tenantId, auth.tenantId), eq(contacts.id, contactId), isNull(contacts.deletedAt)));
    if (!c) throw notFound('Contact');
    await this.accountsSvc.loadAccount(tx, auth, await this.scopes.forRequest(tx, auth), c.accountId, write);
    return c;
  }

  private reachable(auth: TenantAuthContext, c: typeof contacts.$inferSelect, channel: 'email' | 'whatsapp'): string {
    if (c.doNotContact) throw new AppError(409, 'CONTACT_DNC', 'This contact asked not to be contacted');
    const v = this.crypto.decrypt(auth.tenantId, channel === 'email' ? c.emailEnc : c.phoneEnc);
    if (!v) throw new AppError(422, channel === 'email' ? 'CONTACT_NO_EMAIL' : 'CONTACT_NO_PHONE', 'The contact has no address for this channel');
    return v;
  }

  private async dto(tx: Tx, d: DraftRow): Promise<MessageDraftDto> {
    const [c] = await tx.select({ name: contacts.fullName, phoneEnc: contacts.phoneEnc }).from(contacts).where(and(eq(contacts.tenantId, d.tenantId), eq(contacts.id, d.contactId)));
    let sendLink: string | null = null;
    if (d.channel === 'whatsapp' && d.status === 'approved' && c?.phoneEnc) {
      const n = waNumber(this.crypto.decrypt(d.tenantId, c.phoneEnc) ?? '');
      if (n) sendLink = `https://wa.me/${n}?text=${encodeURIComponent(d.body)}`;
    }
    return {
      id: d.id, accountId: d.accountId, contactId: d.contactId, contactName: c?.name ?? '—', visitId: d.visitId, channel: d.channel, subject: d.subject,
      body: d.body, status: d.status, forbiddenHits: d.forbiddenHits, approvalRequestId: d.approvalRequestId, sendLink,
      createdAt: d.createdAt.toISOString(), sentAt: d.sentAt?.toISOString() ?? null,
    };
  }

  async draftFollowUp(auth: TenantAuthContext, accountId: string, input: { contactId: string; channel: 'email' | 'whatsapp'; visitId?: string }): Promise<MessageDraftDto> {
    const prep = await this.db.tenant(auth, async (tx) => {
      const c = await this.loadContact(tx, auth, input.contactId, true);
      if (c.accountId !== accountId) throw notFound('Contact');
      this.reachable(auth, c, input.channel); // DNC / missing address: stop before spending on the model
      const a = await this.accountsSvc.loadAccount(tx, auth, await this.scopes.forRequest(tx, auth), accountId, true);
      const g = await accountGrounding(tx, auth.tenantId, a);
      const [lastVisit] = await tx
        .select()
        .from(visits)
        .where(and(eq(visits.tenantId, auth.tenantId), eq(visits.accountId, accountId), eq(visits.status, 'completed')))
        .orderBy(desc(visits.checkOutAt))
        .limit(1);
      let insights = '';
      if (lastVisit) {
        const [mi] = await tx.select().from(meetingInsights).where(and(eq(meetingInsights.tenantId, auth.tenantId), eq(meetingInsights.visitId, lastVisit.id))).orderBy(desc(meetingInsights.createdAt)).limit(1);
        if (mi) insights = `\n## تحليل آخر اجتماع\n${untrusted('meeting_analysis', `${mi.summary}\nالخطوات التالية: ${JSON.stringify(mi.nextActions)}`)}`;
      }
      const entries = await this.brain.retrieve(tx, auth.tenantId, `${a.industry ?? ''} ${lastVisit?.nextStep ?? ''} ${lastVisit?.outcome ?? ''}`, { sections: ['products', 'differentiators', 'pricing'] });
      return {
        contactName: c.fullName,
        grounding: merge(g, { text: insights, refs: new Map() }, brainGrounding(entries)),
        forbidden: await this.brain.forbiddenPhrases(tx, auth.tenantId),
        visitId: input.visitId ?? lastVisit?.id ?? null,
      };
    });

    const { output } = await this.runtime.run(auth, 'follow_up', { entityType: 'account', entityId: accountId, input: { channel: input.channel } }, async (ctx) => {
      const out = await ctx.call({
        system: `${BASE_RULES}
مهمتك: كتابة مسودة رسالة متابعة ${input.channel === 'email' ? 'بريد إلكتروني (مع عنوان)' : 'واتساب قصيرة (بدون عنوان، أقل من 600 حرف)'} من المندوب إلى ${prep.contactName}.
- مهذبة ومختصرة، تذكّر بما دار في آخر تواصل وتقترح خطوة تالية واضحة.
- لا تذكر سعراً أو خصماً أو التزاماً إلا من المعرفة المعتمدة، وأدرج كل ادعاء في claims مع مرجعه.
- لا تضع روابط أو أرقام هواتف أو بيانات شخصية.
- هذه مسودة سيراجعها إنسان قبل الإرسال.`,
        prompt: prep.grounding.text,
        effort: 'medium',
        schema: followUpSchema,
      });
      const refs = prep.grounding.refs;
      const unsupported = out.claims.filter((c) => !((c.source.startsWith('brain:') || c.source.startsWith('doc:')) && refs.has(c.source))).map((c) => `unsupported_claim: ${c.text}`);
      const hits = [...findForbidden(`${out.subject ?? ''}\n${out.body}`, prep.forbidden), ...unsupported];
      await ctx.step('validation', 'follow_up', { forbiddenHits: hits.length });
      const draft = await this.db.tenant(auth, async (tx) => {
        const [d] = await tx
          .insert(messageDrafts)
          .values({
            tenantId: auth.tenantId, accountId, contactId: input.contactId, visitId: prep.visitId, channel: input.channel,
            subject: input.channel === 'email' ? out.subject : null, body: out.body, forbiddenHits: hits, agentRunId: ctx.runId, createdBy: auth.userId,
          })
          .returning();
        return this.dto(tx, d!);
      });
      return { output: draft };
    });
    return output;
  }

  async list(auth: TenantAuthContext, accountId: string): Promise<MessageDraftDto[]> {
    return this.db.tenant(auth, async (tx) => {
      await this.accountsSvc.loadAccount(tx, auth, await this.scopes.forRequest(tx, auth), accountId);
      const rows = await tx.select().from(messageDrafts).where(and(eq(messageDrafts.tenantId, auth.tenantId), eq(messageDrafts.accountId, accountId))).orderBy(desc(messageDrafts.createdAt)).limit(30);
      return Promise.all(rows.map((r) => this.dto(tx, r)));
    });
  }

  private async loadDraft(tx: Tx, auth: TenantAuthContext, id: string, write: boolean): Promise<DraftRow> {
    const [d] = await tx.select().from(messageDrafts).where(and(eq(messageDrafts.tenantId, auth.tenantId), eq(messageDrafts.id, id)));
    if (!d) throw notFound('Draft');
    await this.accountsSvc.loadAccount(tx, auth, await this.scopes.forRequest(tx, auth), d.accountId, write);
    return d;
  }

  /** Human edits: the forbidden-phrase check is re-run; unsupported-claim warnings are cleared (the human now owns the wording). */
  async update(auth: TenantAuthContext, id: string, input: { subject?: string | null; body: string }): Promise<MessageDraftDto> {
    return this.db.tenant(auth, async (tx) => {
      const d = await this.loadDraft(tx, auth, id, true);
      if (!['draft', 'rejected'].includes(d.status)) throw new AppError(409, 'INVALID_STATE', 'This message can no longer be edited');
      const subject = d.channel === 'email' ? (input.subject === undefined ? d.subject : input.subject) : null;
      const hits = findForbidden(`${subject ?? ''}\n${input.body}`, await this.brain.forbiddenPhrases(tx, auth.tenantId));
      const [r] = await tx
        .update(messageDrafts)
        .set({ subject, body: input.body, forbiddenHits: hits, status: 'draft', updatedAt: new Date() })
        .where(and(eq(messageDrafts.tenantId, auth.tenantId), eq(messageDrafts.id, id)))
        .returning();
      return this.dto(tx, r!);
    });
  }

  /** Sends the draft for approval through the Tool Gateway (EXTERNAL risk). */
  async submit(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<MessageDraftDto> {
    const d = await this.db.tenant(auth, async (tx) => {
      const d = await this.loadDraft(tx, auth, id, true);
      if (d.status !== 'draft') throw new AppError(409, 'INVALID_STATE', 'Only drafts can be submitted');
      if (d.forbiddenHits.length) throw new AppError(409, 'FORBIDDEN_PHRASES', 'Edit the message to remove the flagged phrases first');
      this.reachable(auth, await this.loadContact(tx, auth, d.contactId, true), d.channel);
      return d;
    });
    const payload: SendPayload = { draftId: d.id, contactId: d.contactId, channel: d.channel, subject: d.subject, body: d.body };
    const res = await this.gateway.invoke(auth, d.channel === 'email' ? 'send_email' : 'share_whatsapp', payload, {
      summary: d.channel === 'email' ? `إرسال بريد: ${d.subject ?? ''}` : 'مشاركة رسالة واتساب', requestedByType: d.agentRunId ? 'agent' : 'user',
      agentRunId: d.agentRunId, entityType: 'account', entityId: d.accountId, reason: 'متابعة بعد آخر تواصل',
    }, meta);
    return this.db.tenant(auth, async (tx) => {
      const [r] = await tx
        .update(messageDrafts)
        .set({ status: 'pending_approval', approvalRequestId: res.status === 'pending_approval' ? res.approvalId : null, updatedAt: new Date() })
        .where(and(eq(messageDrafts.tenantId, auth.tenantId), eq(messageDrafts.id, id)))
        .returning();
      return this.dto(tx, r!);
    });
  }

  private async executeSend(auth: TenantAuthContext, p: SendPayload): Promise<Record<string, unknown>> {
    const { d, address } = await this.db.tenant(auth, async (tx) => {
      const [d] = await tx.select().from(messageDrafts).where(and(eq(messageDrafts.tenantId, auth.tenantId), eq(messageDrafts.id, p.draftId)));
      if (!d || d.status !== 'pending_approval') throw new AppError(409, 'INVALID_STATE', 'The draft is no longer waiting for approval');
      const [c] = await tx.select().from(contacts).where(and(eq(contacts.tenantId, auth.tenantId), eq(contacts.id, p.contactId)));
      if (!c) throw notFound('Contact');
      return { d, address: this.reachable(auth, c, p.channel) }; // DNC re-checked at send time
    });
    if (p.channel === 'email') await this.mail.send({ to: address, subject: p.subject ?? '', text: p.body });
    await this.db.tenant(auth, async (tx) => {
      await tx
        .update(messageDrafts)
        .set(p.channel === 'email' ? { status: 'sent', sentAt: new Date(), updatedAt: new Date() } : { status: 'approved', updatedAt: new Date() })
        .where(and(eq(messageDrafts.tenantId, auth.tenantId), eq(messageDrafts.id, p.draftId)));
      await this.activity.record(tx, {
        tenantId: auth.tenantId, accountId: d.accountId, type: p.channel === 'email' ? 'email_sent' : 'whatsapp_approved', actorType: 'user', actorUserId: auth.userId,
        refType: 'message_draft', refId: d.id, summary: p.subject ?? p.body.slice(0, 120),
      });
    });
    // WhatsApp has no sending integration in V1: approval releases a wa.me link the rep opens on their phone.
    return p.channel === 'email' ? { sent: true } : { linkReady: true };
  }

  private async onRejected(auth: TenantAuthContext, p: SendPayload): Promise<void> {
    await this.db.tenant(auth, (tx) =>
      tx
        .update(messageDrafts)
        .set({ status: 'rejected', updatedAt: new Date() })
        .where(and(eq(messageDrafts.tenantId, auth.tenantId), eq(messageDrafts.id, p.draftId), eq(messageDrafts.status, 'pending_approval'))),
    );
  }
}
