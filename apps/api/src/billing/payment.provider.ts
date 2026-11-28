import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Payment provider contract. The app never calls a payment company directly — only through this interface.
 * Card details never reach Rakan: the customer pays on the provider's hosted checkout page.
 */
export interface CheckoutInput {
  orderId: string; // our invoice number (shown in the provider's dashboard)
  amount: number; // halalas, VAT included
  currency: 'SAR';
  customer: { name: string; email: string; phone: string };
  successUrl: string;
  failureUrl: string;
  expiresAt: Date;
}
export interface ProviderCheckout {
  url: string;
  sessionId: string | null;
}
/** A payment attempt as the provider reports it when asked directly with our API key. */
export interface ProviderTransaction {
  id: string;
  orderId: string;
  outcome: 'paid' | 'declined' | 'pending' | 'other';
  rawStatus: string;
  type: string;
  amount: number; // halalas
  currency: string; // ISO 4217 alpha (SAR)
}
export interface PaymentProvider {
  readonly name: string;
  readonly ready: boolean;
  createCheckout(input: CheckoutInput): Promise<ProviderCheckout>;
  getTransaction(id: string): Promise<ProviderTransaction>;
  /** Checks the notification signature over the exact bytes received. False when no secret is configured. */
  verifySignature(raw: Buffer, signature: string | undefined): boolean;
}
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export function hmacHex(secret: string, raw: Buffer | string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function signatureMatches(secret: string | undefined, raw: Buffer, signature: string | undefined): boolean {
  if (!secret || !signature) return false;
  const expected = Buffer.from(hmacHex(secret, raw));
  const got = Buffer.from(signature.trim().toLowerCase());
  return expected.length === got.length && timingSafeEqual(expected, got);
}

const ISO_NUMERIC: Record<string, string> = { '682': 'SAR' };
export const toHalalas = (v: unknown): number => Math.round(Number(v) * 100);

/**
 * EdfaPay Payment Gateway, hosted checkout (docs.edfapay.com, checked 2026-11-28):
 * - POST {base}/api/v1/payment-gateway/initiate, header X-API-KEY
 *   {orderId, currency, amount (SAR decimal), customerDetails{name,email,phone}, auth:"N", recurringInit:"N",
 *    successUrl, failureUrl, issueDate, expireDate (YYYY-MM-DD)} -> {code, data:{redirectUrl}}
 * - GET {base}/api/v1/transactions/filterTransaction?id=<transactionId> -> {data:{content:[{transactionId, orderId, amount,
 *   currencyCode:"682", transactionStatus, paymentStatus, transactionType, ...}]}}
 * - Webhook: POST text/plain, header X-EdfaPay-Signature = hex HMAC-SHA256(webhook secret, raw body);
 *   body {transactionId, orderId, amount, currencyCode, status: Approved|Declined|Pending|Redirect, type: Purchase|Refund|..., ...}
 * Base: sandbox https://demo-api.edfapay.com, live https://app-api.edfapay.com.
 */
export class EdfaPayProvider implements PaymentProvider {
  readonly name = 'edfapay';
  readonly ready: boolean;
  private readonly base: string;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly webhookSecret: string | undefined,
    env: 'sandbox' | 'live',
  ) {
    this.ready = !!apiKey;
    this.base = env === 'live' ? 'https://app-api.edfapay.com/api/v1' : 'https://demo-api.edfapay.com/api/v1';
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.apiKey) throw new Error('Payment provider is not configured');
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), 'x-api-key': this.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: number; message?: string; errorCode?: string | null; data?: unknown };
    if (!res.ok || (typeof body.code === 'number' && body.code >= 400)) {
      throw new Error(`EdfaPay ${path.split('?')[0]} ${res.status}: ${String(body.message ?? body.errorCode ?? '').slice(0, 200)}`);
    }
    return body.data as T;
  }

  async createCheckout(input: CheckoutInput): Promise<ProviderCheckout> {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const data = await this.call<{ redirectUrl?: string }>('/payment-gateway/initiate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderId: input.orderId, currency: input.currency, amount: (input.amount / 100).toFixed(2),
        customerDetails: input.customer, auth: 'N', recurringInit: 'N',
        successUrl: input.successUrl, failureUrl: input.failureUrl, issueDate: day(new Date()), expireDate: day(input.expiresAt),
      }),
    });
    if (!data?.redirectUrl || !/^https:\/\//.test(data.redirectUrl)) throw new Error('EdfaPay returned no checkout URL');
    let sessionId: string | null = null;
    try {
      sessionId = new URL(data.redirectUrl).searchParams.get('sessionId');
    } catch {
      sessionId = null;
    }
    return { url: data.redirectUrl, sessionId };
  }

  async getTransaction(id: string): Promise<ProviderTransaction> {
    const data = await this.call<{ content?: Record<string, unknown>[] }>(`/transactions/filterTransaction?id=${encodeURIComponent(id)}`);
    const t = data?.content?.find((c) => c.transactionId === id);
    if (!t) throw new Error('EdfaPay transaction not found');
    const tx = String(t.transactionStatus ?? '').toUpperCase();
    const pay = String(t.paymentStatus ?? '').toUpperCase();
    // Documented: FAILED / DECLINED. The success values are taken as APPROVED/SUCCESS/CAPTURED and must be
    // confirmed against the sandbox before going live (see docs/19-payments-edfapay.md).
    const outcome: ProviderTransaction['outcome'] =
      tx === 'FAILED' || pay === 'DECLINED' ? 'declined'
        : ['APPROVED', 'SUCCESS', 'CAPTURED'].includes(pay) || ['SUCCESS', 'APPROVED', 'COMPLETED'].includes(tx) ? 'paid'
          : ['PENDING', 'REDIRECT', 'INITIATED', 'IN_PROGRESS'].includes(tx) || ['PENDING', 'REDIRECT'].includes(pay) ? 'pending' : 'other';
    const code = String(t.currencyCode ?? '');
    return {
      id, orderId: String(t.orderId ?? ''), outcome, rawStatus: `${tx}/${pay}`, type: String(t.transactionType ?? '').toUpperCase(),
      amount: toHalalas(t.amount), currency: ISO_NUMERIC[code] ?? code.toUpperCase(),
    };
  }

  verifySignature(raw: Buffer, signature: string | undefined): boolean {
    return signatureMatches(this.webhookSecret, raw, signature);
  }
}

/** Test-only provider (refused in production by config validation). */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly ready = true;
  readonly created: CheckoutInput[] = [];
  readonly transactions = new Map<string, ProviderTransaction>();
  private n = 0;

  constructor(private readonly webhookSecret?: string) {}

  async createCheckout(input: CheckoutInput): Promise<ProviderCheckout> {
    this.created.push(input);
    const sessionId = `fake-session-${++this.n}-${Date.now()}`;
    return { url: `https://pay.example.test/checkout?sessionId=${sessionId}`, sessionId };
  }

  async getTransaction(id: string): Promise<ProviderTransaction> {
    const t = this.transactions.get(id);
    if (!t) throw new Error('not found');
    return { ...t };
  }

  verifySignature(raw: Buffer, signature: string | undefined): boolean {
    return signatureMatches(this.webhookSecret, raw, signature);
  }

  /** Simulates the customer paying on the hosted page; returns the provider's transaction id. */
  pay(orderId: string, overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
    const input = this.created.find((c) => c.orderId === orderId)!;
    const t: ProviderTransaction = {
      id: `fake-tx-${++this.n}`, orderId, outcome: 'paid', rawStatus: 'SUCCESS/APPROVED', type: 'PURCHASE',
      amount: input.amount, currency: 'SAR', ...overrides,
    };
    this.transactions.set(t.id, t);
    return t;
  }
}
