import { Inject, Injectable, Logger } from '@nestjs/common';
import { billingEvents, billingInvoices, memberships, plans, platformAudit, subscriptions, tenants, users, type Tx } from '@rakan/db';
import { VAT_RATE, hasPermission, type BillingInvoiceDto, type BillingOverviewDto, type BillingPeriod, type CheckoutDto } from '@rakan/shared';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, notFound } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../coach/notifications.service';
import { MailService } from '../identity/mail.service';
import { PAYMENT_PROVIDER, type PaymentProvider, type ProviderInvoice } from './payment.provider';

type Row = typeof billingInvoices.$inferSelect;
const DAY = 86400_000;
const INVOICE_TTL_DAYS = 3;

export function addPeriod(from: Date, period: BillingPeriod): Date {
  const d = new Date(from);
  if (period === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

/** Plan price (SAR, VAT-exclusive) -> halalas with 15% VAT. */
export function priceBreakdown(priceSar: number): { subtotal: number; vat: number; total: number } {
  const subtotal = Math.round(priceSar * 100);
  const vat = Math.round((subtotal * VAT_RATE) / 100);
  return { subtotal, vat, total: subtotal + vat };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Subscription payments with Moyasar.
 * - The amount always comes from the plan price on the server (never from the browser), plus 15% VAT.
 * - The customer pays on Moyasar's hosted page; card details never reach Rakan.
 * - A payment counts only after Rakan fetches the invoice from Moyasar with the secret key and checks the
 *   status, amount, currency and our reference. Redirects, callbacks and webhooks are only hints.
 * - Applying a payment is idempotent (row lock + status check): a callback and a webhook for the same payment
 *   extend the subscription once.
 */
@Injectable()
export class BillingService {
  private readonly log = new Logger('Billing');

  constructor(
    private readonly db: DbService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly notes: NotificationsService,
    private readonly mail: MailService,
  ) {}

  private dto(r: Row, tenantName?: string): BillingInvoiceDto {
    return {
      id: r.id, number: r.number, planKey: r.planKey, planName: r.planName, period: r.period,
      subtotal: r.subtotalHalalas / 100, vat: r.vatHalalas / 100, total: r.totalHalalas / 100, currency: r.currency, status: r.status,
      paymentUrl: r.status === 'pending' ? r.paymentUrl : null, periodStart: r.periodStart.toISOString(), periodEnd: r.periodEnd.toISOString(),
      paidAt: r.paidAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), ...(tenantName ? { tenantName } : {}),
    };
  }

  private async subscriptionOf(tenantId: string) {
    return this.db.platform(async (tx) => {
      const [t] = await tx.select({ name: tenants.name, status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId));
      const [s] = await tx.select({ s: subscriptions, key: plans.key }).from(subscriptions).leftJoin(plans, eq(plans.id, subscriptions.planId)).where(eq(subscriptions.tenantId, tenantId));
      return { tenant: t!, sub: s?.s ?? null, planKey: s?.key ?? null };
    });
  }

  async overview(auth: TenantAuthContext): Promise<BillingOverviewDto> {
    const { tenant, sub, planKey } = await this.subscriptionOf(auth.tenantId);
    const all = await this.db.platform((tx) => tx.select().from(plans).where(eq(plans.isActive, true)).orderBy(plans.sort));
    const invoices = await this.db.tenant(auth, (tx) =>
      tx.select().from(billingInvoices).where(eq(billingInvoices.tenantId, auth.tenantId)).orderBy(desc(billingInvoices.createdAt)).limit(50),
    );
    const now = Date.now();
    const paidUntil = sub?.currentPeriodEnd ?? null;
    const needsPayment = (tenant.status === 'trial' && !!sub?.trialEndsAt && sub.trialEndsAt.getTime() < now) || (tenant.status === 'active' && !!paidUntil && paidUntil.getTime() < now);
    return {
      providerReady: this.provider.ready, vatRate: VAT_RATE, canPay: this.provider.ready && hasPermission(auth.role, 'tenant.settings.update'),
      plans: all.map((p) => ({ key: p.key, nameAr: p.nameAr, nameEn: p.nameEn, priceMonthly: p.priceSarMonthly, priceYearly: p.priceSarYearly, current: p.key === planKey })),
      subscription: { planKey, status: tenant.status, trialEndsAt: sub?.trialEndsAt?.toISOString() ?? null, paidUntil: paidUntil?.toISOString() ?? null, needsPayment },
      invoices: invoices.map((r) => this.dto(r)),
    };
  }

  async invoice(auth: TenantAuthContext, id: string): Promise<BillingInvoiceDto & { companyName: string }> {
    const [r] = await this.db.tenant(auth, (tx) => tx.select().from(billingInvoices).where(and(eq(billingInvoices.tenantId, auth.tenantId), eq(billingInvoices.id, id))));
    if (!r) throw notFound('Invoice');
    const { tenant } = await this.subscriptionOf(auth.tenantId);
    return { ...this.dto(r), companyName: tenant.name };
  }

  /** Starts a payment for a plan and period; returns Moyasar's hosted payment page. */
  async checkout(auth: TenantAuthContext, input: { planKey: string; period: BillingPeriod }, meta: RequestMeta): Promise<CheckoutDto> {
    if (!this.provider.ready) throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Online payment is not set up yet');
    const [plan] = await this.db.platform((tx) => tx.select().from(plans).where(and(eq(plans.key, input.planKey), eq(plans.isActive, true))));
    const price = input.period === 'month' ? plan?.priceSarMonthly : plan?.priceSarYearly;
    if (!plan || price === null || price === undefined || price <= 0) throw new AppError(422, 'PLAN_NOT_PURCHASABLE', 'This plan cannot be bought online');

    // An unpaid link for the same choice is reused (no duplicate invoices from double clicks).
    const [open] = await this.db.tenant(auth, (tx) =>
      tx.select().from(billingInvoices).where(and(
        eq(billingInvoices.tenantId, auth.tenantId), eq(billingInvoices.status, 'pending'), eq(billingInvoices.planId, plan.id),
        eq(billingInvoices.period, input.period), gt(billingInvoices.createdAt, new Date(Date.now() - (INVOICE_TTL_DAYS - 1) * DAY)),
      )).orderBy(desc(billingInvoices.createdAt)).limit(1),
    );
    if (open?.paymentUrl && open.subtotalHalalas === priceBreakdown(price).subtotal) return { invoiceId: open.id, paymentUrl: open.paymentUrl };

    const { tenant, sub } = await this.subscriptionOf(auth.tenantId);
    const amounts = priceBreakdown(price);
    const now = new Date();
    const start = sub?.planId === plan.id && sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
    const row = await this.db.tenant(auth, async (tx) => {
      const seq = (await tx.execute(sql`SELECT nextval('billing_invoice_seq') AS n`)).rows[0] as { n: string };
      const number = `RKN-${now.getUTCFullYear()}-${String(seq.n).padStart(6, '0')}`;
      const [r] = await tx
        .insert(billingInvoices)
        .values({
          tenantId: auth.tenantId, number, planId: plan.id, planKey: plan.key, planName: plan.nameAr, period: input.period,
          subtotalHalalas: amounts.subtotal, vatHalalas: amounts.vat, totalHalalas: amounts.total, provider: this.provider.name,
          periodStart: start, periodEnd: addPeriod(start, input.period), createdBy: auth.userId,
        })
        .returning();
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'billing.checkout', entityType: 'billing_invoice', entityId: r!.id,
        after: { number, plan: plan.key, period: input.period, total: amounts.total / 100 }, meta,
      });
      return r!;
    });

    let pi: ProviderInvoice;
    try {
      const back = `${this.config.WEB_ORIGIN}/settings/billing?invoice=${row.id}`;
      pi = await this.provider.createInvoice({
        amount: amounts.total, currency: 'SAR',
        description: `اشتراك راكان — ${plan.nameAr} (${input.period === 'month' ? 'شهري' : 'سنوي'}) — ${tenant.name} — ${row.number}`,
        successUrl: back, backUrl: `${back}&canceled=1`, callbackUrl: `${this.config.WEB_ORIGIN}/api/public/billing/moyasar/callback`,
        expiresAt: new Date(Date.now() + INVOICE_TTL_DAYS * DAY), metadata: { rakan_invoice_id: row.id, tenant_id: auth.tenantId, number: row.number },
      });
    } catch (e) {
      this.log.error({ err: e, invoice: row.id }, 'payment provider invoice failed');
      await this.db.platform((tx) => tx.update(billingInvoices).set({ status: 'failed', failureReason: 'provider_error', updatedAt: new Date() }).where(eq(billingInvoices.id, row.id)));
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not start the payment, please try again');
    }
    await this.db.platform((tx) =>
      tx.update(billingInvoices).set({ providerInvoiceId: pi.id, paymentUrl: pi.url, providerStatus: pi.status, updatedAt: new Date() }).where(eq(billingInvoices.id, row.id)),
    );
    if (!pi.url) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment page was not created');
    return { invoiceId: row.id, paymentUrl: pi.url };
  }

  /** "I paid" / back from the payment page: re-checks with Moyasar. */
  async verify(auth: TenantAuthContext, id: string): Promise<BillingInvoiceDto> {
    const [r] = await this.db.tenant(auth, (tx) => tx.select().from(billingInvoices).where(and(eq(billingInvoices.tenantId, auth.tenantId), eq(billingInvoices.id, id))));
    if (!r) throw notFound('Invoice');
    return this.dto(await this.sync(r.id));
  }

  /** The only place a payment is accepted: fetch from the provider and check everything. */
  async sync(id: string): Promise<Row> {
    const [r] = await this.db.platform((tx) => tx.select().from(billingInvoices).where(eq(billingInvoices.id, id)));
    if (!r) throw notFound('Invoice');
    if (r.status !== 'pending' || !r.providerInvoiceId) return r;
    let pi: ProviderInvoice;
    try {
      pi = await this.provider.getInvoice(r.providerInvoiceId);
    } catch (e) {
      this.log.warn({ err: e, invoice: id }, 'could not fetch invoice from provider');
      return r;
    }
    if (pi.metadata?.rakan_invoice_id && pi.metadata.rakan_invoice_id !== r.id) return this.mark(r, 'failed', pi, 'reference_mismatch');
    if (pi.status === 'paid') {
      if (pi.amount !== r.totalHalalas || pi.currency.toUpperCase() !== r.currency) return this.mark(r, 'failed', pi, 'amount_mismatch');
      return this.applyPaid(r.id, pi);
    }
    if (pi.status === 'expired') return this.mark(r, 'expired', pi, null);
    if (pi.status === 'canceled' || pi.status === 'voided') return this.mark(r, 'canceled', pi, null);
    if (pi.status !== r.providerStatus) {
      await this.db.platform((tx) => tx.update(billingInvoices).set({ providerStatus: pi.status, updatedAt: new Date() }).where(eq(billingInvoices.id, r.id)));
    }
    return { ...r, providerStatus: pi.status };
  }

  private async mark(r: Row, status: 'failed' | 'expired' | 'canceled', pi: ProviderInvoice, reason: string | null): Promise<Row> {
    const [u] = await this.db.platform((tx) =>
      tx.update(billingInvoices).set({ status, providerStatus: pi.status, failureReason: reason, updatedAt: new Date() })
        .where(and(eq(billingInvoices.id, r.id), eq(billingInvoices.status, 'pending'))).returning(),
    );
    if (reason) {
      this.log.error({ invoice: r.id, reason, providerStatus: pi.status, amount: pi.amount }, 'payment check failed');
      await this.db.platform((tx) => tx.insert(platformAudit).values({ action: 'billing.check_failed', tenantId: r.tenantId, after: { number: r.number, reason, providerInvoiceId: pi.id } }));
    }
    return u ?? r;
  }

  private async applyPaid(id: string, pi: ProviderInvoice): Promise<Row> {
    const result = await this.db.platform(async (tx: Tx) => {
      const [r] = await tx.select().from(billingInvoices).where(eq(billingInvoices.id, id)).for('update');
      if (!r || r.status !== 'pending') return { row: r!, applied: false, suspended: false };
      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.tenantId, r.tenantId)).for('update');
      const now = new Date();
      const start = sub?.planId === r.planId && sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
      const end = addPeriod(start, r.period);
      const [paid] = await tx
        .update(billingInvoices)
        .set({ status: 'paid', paidAt: now, providerPaymentId: pi.paymentId, providerStatus: pi.status, periodStart: start, periodEnd: end, updatedAt: now })
        .where(eq(billingInvoices.id, id))
        .returning();
      if (sub) await tx.update(subscriptions).set({ planId: r.planId, trialEndsAt: null, currentPeriodEnd: end, updatedAt: now }).where(eq(subscriptions.tenantId, r.tenantId));
      else await tx.insert(subscriptions).values({ tenantId: r.tenantId, planId: r.planId, currentPeriodEnd: end });
      const [t] = await tx.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, r.tenantId));
      if (t?.status === 'trial') await tx.update(tenants).set({ status: 'active', updatedAt: now }).where(eq(tenants.id, r.tenantId));
      await tx.insert(platformAudit).values({
        action: 'billing.paid', tenantId: r.tenantId,
        after: { number: r.number, plan: r.planKey, period: r.period, total: r.totalHalalas / 100, paidUntil: end.toISOString(), providerPaymentId: pi.paymentId },
      });
      return { row: paid!, applied: true, suspended: t?.status === 'suspended' || t?.status === 'cancelled' };
    });
    if (result.applied) await this.afterPaid(result.row, result.suspended);
    return result.row;
  }

  private async afterPaid(r: Row, suspended: boolean): Promise<void> {
    await this.db.run({ tenantId: r.tenantId }, (tx) =>
      this.audit.record(tx, {
        tenantId: r.tenantId, actorType: 'system', action: 'billing.paid', entityType: 'billing_invoice', entityId: r.id,
        after: { number: r.number, plan: r.planKey, total: r.totalHalalas / 100, paidUntil: r.periodEnd.toISOString() },
      }),
    );
    const owners = await this.db.run({ tenantId: r.tenantId }, (tx) =>
      tx.select({ userId: users.id, email: users.email, name: users.fullName }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, r.tenantId), eq(memberships.status, 'active'), inArray(memberships.role, ['owner']))),
    );
    const until = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { dateStyle: 'long', timeZone: 'Asia/Riyadh' }).format(r.periodEnd);
    for (const o of owners) {
      await this.notes.notify({
        tenantId: r.tenantId, userId: o.userId, kind: 'billing_paid', title: `تم استلام دفعة الاشتراك ${r.number}`,
        body: `${r.planName} · ${(r.totalHalalas / 100).toFixed(2)} ر.س شامل الضريبة · ساري حتى ${until}${suspended ? '\nحساب شركتكم موقوف حالياً، وسيراجعه فريق راكان لإعادة التفعيل.' : ''}`,
        links: [{ label: 'الإيصال', href: `/print/receipts/${r.id}` }],
      }).catch(() => undefined);
      await this.mail.send({
        to: o.email, subject: `راكان — إيصال دفع ${r.number}`,
        text: `مرحباً ${o.name}،\n\nاستلمنا دفعة اشتراك راكان:\nالرقم: ${r.number}\nالباقة: ${r.planName} (${r.period === 'month' ? 'شهري' : 'سنوي'})\nالمبلغ قبل الضريبة: ${(r.subtotalHalalas / 100).toFixed(2)} ر.س\nضريبة القيمة المضافة 15%: ${(r.vatHalalas / 100).toFixed(2)} ر.س\nالإجمالي: ${(r.totalHalalas / 100).toFixed(2)} ر.س\nساري حتى: ${until}\n\nهذا إيصال دفع. الفاتورة الضريبية الإلكترونية تصدر بعد ربط منصة فاتورة.\n\nفريق راكان`,
      }).catch((e) => this.log.warn({ err: e }, 'receipt email failed'));
    }
  }

  // ---------------------------------------------------------------- provider notifications

  /** Invoice callback (POST from Moyasar with the invoice object). Unsigned, so only used as a hint to re-check. */
  async callback(body: unknown): Promise<{ ok: true }> {
    const pid = (body as { id?: unknown } | null)?.id;
    if (typeof pid === 'string' && pid.length <= 100) {
      const [r] = await this.db.platform((tx) => tx.select({ id: billingInvoices.id }).from(billingInvoices).where(eq(billingInvoices.providerInvoiceId, pid)));
      if (r) await this.sync(r.id);
    }
    return { ok: true };
  }

  /** Account webhook: shared secret checked, each event handled once, payment re-checked with the provider. */
  async webhook(body: unknown): Promise<{ ok: true }> {
    const secret = this.config.MOYASAR_WEBHOOK_SECRET;
    if (!secret) throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Webhook secret not configured');
    const e = body as { id?: string; type?: string; secret_token?: string; live?: boolean; data?: { id?: string; invoice_id?: string; verification_code?: string } } | null;
    if (!e || typeof e.secret_token !== 'string' || !safeEqual(e.secret_token, secret)) throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook secret');
    if (typeof e.id !== 'string' || typeof e.type !== 'string') throw new AppError(400, 'VALIDATION_ERROR', 'Malformed event');
    const ref = e.data?.invoice_id ?? null;
    const [fresh] = await this.db.platform((tx) =>
      tx.insert(billingEvents).values({ provider: 'moyasar', eventId: e.id!, type: e.type!, ref, live: e.live ?? null })
        .onConflictDoNothing({ target: [billingEvents.provider, billingEvents.eventId] }).returning({ id: billingEvents.id }),
    );
    if (!fresh) return { ok: true }; // already handled
    let outcome = 'ignored';
    if (e.type === 'webhook_verification') {
      await this.db.platform((tx) => tx.insert(platformAudit).values({ action: 'billing.webhook_verification', after: { code: e.data?.verification_code ?? null } }));
      outcome = 'verification_logged';
    } else if (ref) {
      const [r] = await this.db.platform((tx) => tx.select({ id: billingInvoices.id }).from(billingInvoices).where(eq(billingInvoices.providerInvoiceId, ref)));
      if (r) outcome = (await this.sync(r.id)).status;
      if (e.type === 'payment_refunded' && r) {
        await this.db.platform((tx) => tx.insert(platformAudit).values({ action: 'billing.refunded', after: { providerInvoiceId: ref, paymentId: e.data?.id ?? null } }));
        outcome = 'refund_logged';
      }
    }
    await this.db.platform((tx) => tx.update(billingEvents).set({ outcome }).where(and(eq(billingEvents.provider, 'moyasar'), eq(billingEvents.eventId, e.id!))));
    return { ok: true };
  }

  // ---------------------------------------------------------------- platform console

  async platformInvoices(tenantId?: string): Promise<BillingInvoiceDto[]> {
    return this.db.platform(async (tx) => {
      const rows = await tx
        .select({ r: billingInvoices, name: tenants.name })
        .from(billingInvoices)
        .innerJoin(tenants, eq(tenants.id, billingInvoices.tenantId))
        .where(tenantId ? eq(billingInvoices.tenantId, tenantId) : undefined)
        .orderBy(desc(billingInvoices.createdAt))
        .limit(200);
      return rows.map(({ r, name }) => this.dto(r, name));
    });
  }
}
