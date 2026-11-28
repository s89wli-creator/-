import { z } from 'zod';

/** Subscription payments (EdfaPay). Amounts are VAT-exclusive plan prices; 15% VAT is added at checkout. */
export const BILLING_PERIODS = ['month', 'year'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];
/** Saudi mobile, normalized to +9665XXXXXXXX (EdfaPay requires the payer's phone). */
export const saudiMobile = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^(\+966|00966|966|0)?5\d{8}$/.test(v), 'Enter a Saudi mobile number like 05XXXXXXXX')
  .transform((v) => `+966${v.replace(/^(\+966|00966|966|0)/, '')}`);
export const checkoutSchema = z.object({ planKey: z.string().trim().min(1).max(40), period: z.enum(BILLING_PERIODS), phone: saudiMobile });

export interface BillingInvoiceDto {
  id: string; number: string; planKey: string; planName: string; period: BillingPeriod;
  subtotal: number; vat: number; total: number; currency: string;
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'canceled'; paymentUrl: string | null;
  periodStart: string; periodEnd: string; paidAt: string | null; createdAt: string; tenantName?: string;
}

export interface BillingOverviewDto {
  providerReady: boolean;
  vatRate: number;
  plans: { key: string; nameAr: string; nameEn: string; priceMonthly: number | null; priceYearly: number | null; current: boolean }[];
  subscription: { planKey: string | null; status: string; trialEndsAt: string | null; paidUntil: string | null; needsPayment: boolean };
  invoices: BillingInvoiceDto[];
  canPay: boolean;
}

export interface CheckoutDto { invoiceId: string; paymentUrl: string }
