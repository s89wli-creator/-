/**
 * Payment provider contract. The app never calls a payment company directly — only through this interface.
 * Card details never reach Rakan: the customer pays on the provider's hosted page.
 */
export interface ProviderInvoice {
  id: string;
  status: string; // initiated | paid | failed | refunded | canceled | on_hold | expired | voided
  amount: number; // halalas
  currency: string;
  url: string | null;
  metadata: Record<string, string>;
  paymentId: string | null;
}
export interface CreateInvoiceInput {
  amount: number; currency: string; description: string; successUrl: string; backUrl: string; callbackUrl: string;
  expiresAt: Date; metadata: Record<string, string>;
}
export interface PaymentProvider {
  readonly name: string;
  readonly ready: boolean;
  createInvoice(input: CreateInvoiceInput): Promise<ProviderInvoice>;
  getInvoice(id: string): Promise<ProviderInvoice>;
}
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

type MoyasarInvoice = {
  id: string; status: string; amount: number; currency: string; url?: string; metadata?: Record<string, string> | null;
  payments?: { id: string; status: string }[];
};

/**
 * Moyasar Invoices API (docs.moyasar.com, checked 2026-11-28):
 * - POST /v1/invoices {amount (halalas), currency, description, success_url, back_url, callback_url, expired_at, metadata}
 *   -> { id, status, url, ... }  The customer pays on `url` (Moyasar-hosted).
 * - GET /v1/invoices/:id -> { status: initiated|paid|failed|refunded|canceled|on_hold|expired|voided, payments[] }
 * Auth: HTTP Basic with the secret key as the user name (server side only).
 */
export class MoyasarProvider implements PaymentProvider {
  readonly name = 'moyasar';
  readonly ready: boolean;
  private readonly base = 'https://api.moyasar.com/v1';

  constructor(private readonly secretKey: string | undefined) {
    this.ready = !!secretKey;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.secretKey) throw new Error('Payment provider is not configured');
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as T & { message?: string; type?: string };
    if (!res.ok) throw new Error(`Moyasar ${path} ${res.status}: ${String(body.message ?? body.type ?? '').slice(0, 200)}`);
    return body;
  }

  private map(i: MoyasarInvoice): ProviderInvoice {
    const paid = i.payments?.find((p) => p.status === 'paid' || p.status === 'captured');
    return { id: i.id, status: i.status, amount: i.amount, currency: i.currency, url: i.url ?? null, metadata: i.metadata ?? {}, paymentId: paid?.id ?? null };
  }

  async createInvoice(input: CreateInvoiceInput): Promise<ProviderInvoice> {
    return this.map(await this.call<MoyasarInvoice>('/invoices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        amount: input.amount, currency: input.currency, description: input.description, success_url: input.successUrl,
        back_url: input.backUrl, callback_url: input.callbackUrl, expired_at: input.expiresAt.toISOString(), metadata: input.metadata,
      }),
    }));
  }

  async getInvoice(id: string): Promise<ProviderInvoice> {
    return this.map(await this.call<MoyasarInvoice>(`/invoices/${encodeURIComponent(id)}`));
  }
}

/** Test-only provider (refused in production by config validation). */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly ready = true;
  readonly invoices = new Map<string, ProviderInvoice>();
  readonly created: CreateInvoiceInput[] = [];
  private n = 0;

  async createInvoice(input: CreateInvoiceInput): Promise<ProviderInvoice> {
    this.created.push(input);
    const inv: ProviderInvoice = {
      id: `fake-inv-${++this.n}-${Date.now()}`, status: 'initiated', amount: input.amount, currency: input.currency,
      url: `https://pay.example.test/i/${this.n}`, metadata: input.metadata, paymentId: null,
    };
    this.invoices.set(inv.id, inv);
    return { ...inv };
  }

  async getInvoice(id: string): Promise<ProviderInvoice> {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error('not found');
    return { ...inv };
  }

  /** Simulates the customer paying on the hosted page. */
  pay(id: string, overrides: Partial<ProviderInvoice> = {}): void {
    const inv = this.invoices.get(id)!;
    this.invoices.set(id, { ...inv, status: 'paid', paymentId: `fake-pay-${id}`, ...overrides });
  }
}
