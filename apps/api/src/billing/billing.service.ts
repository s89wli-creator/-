import { Inject, Injectable, Logger } from '@nestjs/common';
import { billingEvents, billingInvoices, memberships, plans, platformAudit, subscriptions, tenants, users, type Tx } from '@rakan/db';
import { VAT_RATE, hasPermission, type BillingInvoiceDto, type BillingOverviewDto, type BillingPeriod, type CheckoutDto } from '@rakan/shared';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, notFound } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../coach/notifications.service';
import { MailService } from '../identity/mail.service';
import { PAYMENT_PROVIDER, type PaymentProvider, type ProviderTransaction } from './payment.provider';

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

/**
 * Subscription payments with EdfaPay (hosted checkout).
 * - The amount always comes from the plan price on the server (never from the browser), plus 15% VAT.
 * - The customer pays on EdfaPay's hosted page; card details never reach Rakan.
 * - EdfaPay tells us about a payment with a signed notification (HMAC-SHA256 over the raw body). Even then, a
 *   payment counts only after Rakan asks EdfaPay for that transaction with the API key and checks the status,
 *   amount, currency and our order reference. Redirects back to the app are only hints.
 * - Applying a payment is idempotent (row lock + status check): repeated notifications extend the subscription once.
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

  /** Starts a payment for a plan and period; returns EdfaPay's hosted checkout page. */
  async checkout(auth: TenantAuthContext, input: { planKey: string; period: BillingPeriod; phone: string }, meta: RequestMeta): Promise<CheckoutDto> {
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

    // EdfaPay requires the payer's name, email and phone. The phone is sent to EdfaPay only, not stored by Rakan.
    const [payer] = await this.db.platform((tx) => tx.select({ name: users.fullName, email: users.email }).from(users).where(eq(users.id, auth.userId)));
    let co: { url: string; sessionId: string | null };
    try {
      const back = `${this.config.WEB_ORIGIN}/settings/billing?invoice=${row.id}`;
      co = await this.provider.createCheckout({
        orderId: row.number, amount: amounts.total, currency: 'SAR',
        customer: { name: payer?.name || tenant.name, email: payer!.email, phone: input.phone },
        successUrl: back, failureUrl: `${back}&canceled=1`, expiresAt: new Date(Date.now() + INVOICE_TTL_DAYS * DAY),
      });
    } catch (e) {
      this.log.error({ err: e, invoice: row.id }, 'payment provider invoice failed');
      await this.db.platform((tx) => tx.update(billingInvoices).set({ status: 'failed', failureReason: 'provider_error', updatedAt: new Date() }).where(eq(billingInvoices.id, row.id)));
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not start the payment, please try again');
    }
    await this.db.platform((tx) =>
      tx.update(billingInvoices).set({ providerInvoiceId: co.sessionId, paymentUrl: co.url, providerStatus: 'initiated', updatedAt: new Date() }).where(eq(billingInvoices.id, row.id)),
    );
    return { invoiceId: row.id, paymentUrl: co.url };
  }

  /** "I paid" / back from the payment page: re-checks with EdfaPay (once EdfaPay has told us the transaction). */
  async verify(auth: TenantAuthContext, id: string): Promise<BillingInvoiceDto> {
    const [r] = await this.db.tenant(auth, (tx) => tx.select().from(billingInvoices).where(and(eq(billingInvoices.tenantId, auth.tenantId), eq(billingInvoices.id, id))));
    if (!r) throw notFound('Invoice');
    return this.dto(await this.sync(r.id));
  }

  /** The only place a payment is accepted: ask the provider about the transaction and check everything. */
  async sync(id: string): Promise<Row> {
    const [r] = await this.db.platform((tx) => tx.select().from(billingInvoices).where(eq(billingInvoices.id, id)));
    if (!r) throw notFound('Invoice');
    if (r.status !== 'pending') return r;
    if (!r.providerPaymentId) {
      // No payment reported yet. Past the link's lifetime the invoice is closed (a new one can be started).
      if (r.createdAt.getTime() < Date.now() - INVOICE_TTL_DAYS * DAY) return this.mark(r, 'expired', r.providerStatus, null);
      return r;
    }
    let t: ProviderTransaction;
    try {
      t = await this.provider.getTransaction(r.providerPaymentId);
    } catch (e) {
      this.log.warn({ err: e, invoice: id }, 'could not fetch transaction from provider');
      return r;
    }
    if (t.orderId !== r.number) return this.mark(r, 'failed', t.rawStatus, 'reference_mismatch', t.id);
    if (t.outcome === 'paid') {
      if (t.type && t.type !== 'PURCHASE') return this.mark(r, 'failed', t.rawStatus, 'unexpected_type', t.id);
      if (t.amount !== r.totalHalalas || t.currency !== r.currency) return this.mark(r, 'failed', t.rawStatus, 'amount_mismatch', t.id);
      return this.applyPaid(r.id, t);
    }
    // A declined card keeps the invoice open: the customer can try again on the same page until it expires.
    const failureReason = t.outcome === 'declined' ? 'declined' : r.failureReason;
    if (t.rawStatus !== r.providerStatus || failureReason !== r.failureReason) {
      await this.db.platform((tx) => tx.update(billingInvoices).set({ providerStatus: t.rawStatus, failureReason, updatedAt: new Date() }).where(eq(billingInvoices.id, r.id)));
    }
    return { ...r, providerStatus: t.rawStatus, failureReason };
  }

  private async mark(r: Row, status: 'failed' | 'expired' | 'canceled', providerStatus: string | null, reason: string | null, transactionId?: string): Promise<Row> {
    const [u] = await this.db.platform((tx) =>
      tx.update(billingInvoices).set({ status, providerStatus, failureReason: reason, updatedAt: new Date() })
        .where(and(eq(billingInvoices.id, r.id), eq(billingInvoices.status, 'pending'))).returning(),
    );
    if (reason) {
      this.log.error({ invoice: r.id, reason, providerStatus, transactionId }, 'payment check failed');
      await this.db.platform((tx) => tx.insert(platformAudit).values({ action: 'billing.check_failed', tenantId: r.tenantId, after: { number: r.number, reason, transactionId: transactionId ?? null } }));
    }
    return u ?? r;
  }

  private async applyPaid(id: string, ptx: ProviderTransaction): Promise<Row> {
    const result = await this.db.platform(async (tx: Tx) => {
      const [r] = await tx.select().from(billingInvoices).where(eq(billingInvoices.id, id)).for('update');
      if (!r || r.status !== 'pending') return { row: r!, applied: false, suspended: false };
      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.tenantId, r.tenantId)).for('update');
      const now = new Date();
      const start = sub?.planId === r.planId && sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
      const end = addPeriod(start, r.period);
      const [paid] = await tx
        .update(billingInvoices)
        .set({ status: 'paid', paidAt: now, providerPaymentId: ptx.id, providerStatus: ptx.rawStatus, failureReason: null, periodStart: start, periodEnd: end, updatedAt: now })
        .where(eq(billingInvoices.id, id))
        .returning();
      if (sub) await tx.update(subscriptions).set({ planId: r.planId, trialEndsAt: null, currentPeriodEnd: end, updatedAt: now }).where(eq(subscriptions.tenantId, r.tenantId));
      else await tx.insert(subscriptions).values({ tenantId: r.tenantId, planId: r.planId, currentPeriodEnd: end });
      const [t] = await tx.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, r.tenantId));
      if (t?.status === 'trial') await tx.update(tenants).set({ status: 'active', updatedAt: now }).where(eq(tenants.id, r.tenantId));
      await tx.insert(platformAudit).values({
        action: 'billing.paid', tenantId: r.tenantId,
        after: { number: r.number, plan: r.planKey, period: r.period, total: r.totalHalalas / 100, paidUntil: end.toISOString(), transactionId: ptx.id },
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

  /**
   * EdfaPay notification (POST, text/plain JSON). Signature checked over the raw bytes, each (transaction, type,
   * status) handled once, and the payment itself re-checked with EdfaPay's API before anything changes.
   */
  async webhook(raw: unknown, signature: string | undefined): Promise<{ ok: true }> {
    if (!this.config.EDFAPAY_WEBHOOK_SECRET) throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Webhook secret not configured');
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === 'string' ? raw : '');
    if (!this.provider.verifySignature(body, signature)) throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
    let e: { transactionId?: unknown; orderId?: unknown; status?: unknown; type?: unknown } | null;
    try {
      e = JSON.parse(body.toString('utf8')) as typeof e;
    } catch {
      e = null;
    }
    const str = (v: unknown, max = 100) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
    const txId = str(e?.transactionId);
    const orderId = str(e?.orderId);
    const status = str(e?.status, 40) ?? '';
    const type = str(e?.type, 40) ?? '';
    if (!txId || !orderId) throw new AppError(400, 'VALIDATION_ERROR', 'Malformed notification');

    const eventId = `${txId}:${orderId}:${type}:${status}`.slice(0, 240);
    const [fresh] = await this.db.platform((tx) =>
      tx.insert(billingEvents).values({ provider: 'edfapay', eventId, type: `${type}:${status}`, ref: orderId, live: null })
        .onConflictDoNothing({ target: [billingEvents.provider, billingEvents.eventId] }).returning({ id: billingEvents.id }),
    );
    if (!fresh) return { ok: true }; // already handled
    const [r] = await this.db.platform((tx) => tx.select().from(billingInvoices).where(eq(billingInvoices.number, orderId)));
    let outcome = 'unknown_order';
    if (r && /^purchase$/i.test(type)) {
      if (r.status === 'pending') {
        await this.db.platform((tx) =>
          tx.update(billingInvoices).set({ providerPaymentId: txId, providerStatus: status, updatedAt: new Date() })
            .where(and(eq(billingInvoices.id, r.id), eq(billingInvoices.status, 'pending'))),
        );
      }
      outcome = (await this.sync(r.id)).status;
    } else if (r && /^refund$/i.test(type)) {
      await this.db.platform((tx) => tx.insert(platformAudit).values({ action: 'billing.refunded', tenantId: r.tenantId, after: { number: r.number, transactionId: txId, status } }));
      outcome = 'refund_logged';
    } else if (r) {
      outcome = 'ignored';
    }
    await this.db.platform((tx) => tx.update(billingEvents).set({ outcome }).where(and(eq(billingEvents.provider, 'edfapay'), eq(billingEvents.eventId, eventId))));
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
