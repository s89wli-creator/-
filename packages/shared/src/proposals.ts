import { z } from 'zod';

/** Commercial proposals (quotations). Money is in SAR with 2 decimals; VAT is 15% (KSA). */
export const VAT_RATE = 15;
export const PROPOSAL_STATUSES = ['draft', 'pending_approval', 'sent', 'accepted', 'declined', 'cancelled'] as const;
export type ProposalStatusKey = (typeof PROPOSAL_STATUSES)[number];

export const proposalItemInputSchema = z.object({
  /** An approved Sales Brain pricing item: the server copies its name, unit and price. */
  brainItemId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).optional(),
  unit: z.string().trim().max(60).optional(),
  quantity: z.number().positive().max(1_000_000),
  /** Only for lines not on the price list (marked "manual price" for the approver). */
  unitPrice: z.number().min(0).max(100_000_000).optional(),
  discountPct: z.number().min(0).max(100).default(0),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const proposalCreateSchema = z.object({
  accountId: z.string().uuid(),
  opportunityId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  title: z.string().trim().min(2).max(200),
  intro: z.string().trim().max(5000).default(''),
  terms: z.string().trim().max(10000).optional(),
  validUntil: isoDate.optional(),
  items: z.array(proposalItemInputSchema).max(100).default([]),
});

export const proposalUpdateSchema = z.object({
  opportunityId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(2).max(200).optional(),
  intro: z.string().trim().max(5000).optional(),
  terms: z.string().trim().max(10000).optional(),
  validUntil: isoDate.optional(),
  items: z.array(proposalItemInputSchema).max(100).optional(),
});

export const proposalDraftAiSchema = z.object({
  accountId: z.string().uuid(),
  opportunityId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  request: z.string().trim().min(5).max(2000),
});

export const proposalDecisionSchema = z.object({
  decision: z.enum(['accept', 'decline']),
  name: z.string().trim().min(2).max(120),
  note: z.string().trim().max(1000).optional(),
});

export const proposalListQuerySchema = z.object({
  status: z.enum(PROPOSAL_STATUSES).optional(),
  accountId: z.string().uuid().optional(),
});

export interface ProposalItemDto {
  id: string; sort: number; name: string; description: string | null; unit: string | null; quantity: number; unitPrice: number;
  discountPct: number; lineTotal: number; priceSource: 'price_list' | 'manual'; brainItemId: string | null;
}
export type ProposalWarning =
  | { code: 'manual_price'; item: string }
  | { code: 'price_changed'; item: string; listPrice: number }
  | { code: 'no_discount_policy' }
  | { code: 'discount_above_rep_limit'; item: string; limit: number }
  | { code: 'missing_contact_email' }
  | { code: 'contact_dnc' }
  | { code: 'no_items' };

export interface ProposalDto {
  id: string; number: string; title: string; intro: string; terms: string; currency: string; vatRate: number;
  subtotal: number; discountTotal: number; vatAmount: number; total: number; validUntil: string; expired: boolean;
  status: ProposalStatusKey; version: number; source: 'user' | 'agent'; agentRunId: string | null; approvalRequestId: string | null;
  account: { id: string; name: string }; opportunity: { id: string; name: string } | null; contact: { id: string; name: string } | null;
  ownerName: string | null; createdByName: string | null;
  items: ProposalItemDto[]; warnings: ProposalWarning[];
  shareUrl: string | null; sentAt: string | null; viewedAt: string | null; decidedAt: string | null; decisionByName: string | null; decisionNote: string | null;
  createdAt: string; updatedAt: string;
  /** Present on drafts the agent prepared: customer needs it could not price from the approved price list. */
  unmatchedNeeds?: string[];
}
export type ProposalSummaryDto = Pick<ProposalDto, 'id' | 'number' | 'title' | 'status' | 'total' | 'currency' | 'validUntil' | 'expired' | 'account' | 'ownerName' | 'updatedAt' | 'sentAt' | 'viewedAt'>;

export interface PriceListItemDto { id: string; product: string; price: number; unit: string | null; currency: string; version: number }

/** What the customer sees through the private link (no internal fields). */
export interface PublicProposalDto {
  number: string; title: string; intro: string; terms: string; currency: string; vatRate: number;
  subtotal: number; discountTotal: number; vatAmount: number; total: number; validUntil: string; expired: boolean;
  status: 'sent' | 'accepted' | 'declined' | 'cancelled'; companyName: string; customerName: string; preparedBy: string | null;
  items: { name: string; description: string | null; unit: string | null; quantity: number; unitPrice: number; discountPct: number; lineTotal: number }[];
  sentAt: string | null; decidedAt: string | null; decisionByName: string | null;
}
