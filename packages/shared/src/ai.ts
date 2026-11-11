import { z } from 'zod';

// ---------------------------------------------------------------- account security

export const totpCodeSchema = z.object({ code: z.string().trim().regex(/^(\d{6}|[a-z0-9]{10})$/i, 'invalid code') });
export const mfaLoginSchema = z.object({ challenge: z.string().min(20).max(200), code: z.string().trim().min(6).max(20) });
export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });

// ---------------------------------------------------------------- Sales Brain

/** The 20 Sales Brain sections from the product spec (+ onboarding/contracting used by marketplaces like Enjazni). */
export const BRAIN_SECTIONS = [
  'company_profile', 'products', 'pricing', 'differentiators', 'target_segments', 'target_regions', 'icp', 'non_fit',
  'objections', 'discount_rules', 'rep_authority', 'tone', 'commercial_policy', 'sales_goals', 'competitors',
  'proposal_templates', 'faq', 'forbidden', 'onboarding_process', 'contracting_process',
] as const;
export type BrainSection = (typeof BRAIN_SECTIONS)[number];
export const BRAIN_STATUSES = ['draft', 'pending_confirmation', 'approved', 'archived'] as const;

/** Section-specific structured fields (validated server-side). */
export const brainFieldSchemas: Partial<Record<BrainSection, z.ZodTypeAny>> = {
  pricing: z.object({ product: z.string().trim().min(1).max(120), price: z.number().min(0), unit: z.string().trim().max(60).optional(), currency: z.string().length(3).default('SAR') }),
  objections: z.object({ objection: z.string().trim().min(2).max(500), response: z.string().trim().min(2).max(2000) }),
  forbidden: z.object({ phrase: z.string().trim().min(2).max(200) }),
  discount_rules: z.object({ maxDiscountPctRep: z.number().min(0).max(100), maxDiscountPctManager: z.number().min(0).max(100) }),
  competitors: z.object({ name: z.string().trim().min(1).max(120) }),
};

export const brainItemSchema = z.object({
  section: z.enum(BRAIN_SECTIONS),
  trackId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(2).max(200),
  body: z.string().trim().max(10_000).default(''),
  fields: z.record(z.unknown()).default({}),
  status: z.enum(['draft', 'pending_confirmation']).default('draft'),
});
export type BrainItemInput = z.infer<typeof brainItemSchema>;
export const brainItemUpdateSchema = brainItemSchema.omit({ section: true }).partial();

export const brainDocumentSchema = z.object({
  title: z.string().trim().min(2).max(200),
  content: z.string().trim().min(10).max(200_000),
});

// ---------------------------------------------------------------- AI settings, approvals

export const AGENTS = ['lead_intel', 'visit_brief', 'meeting_intel', 'follow_up', 'prospecting', 'assistant', 'proposal'] as const;
export type AgentKey = (typeof AGENTS)[number];

export const aiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  monthlyBudgetUsd: z.number().min(0).max(100_000).optional(),
  agents: z.record(z.enum(AGENTS), z.object({ enabled: z.boolean() })).optional(),
  voiceEnabled: z.boolean().optional(),
});

export const SCORING_CRITERIA = ['icp_fit', 'need_size', 'region_fit', 'buying_power', 'recurring_need', 'data_quality'] as const;
export type ScoringCriterion = (typeof SCORING_CRITERIA)[number];
export const scoringWeightsSchema = z.object({
  weights: z.record(z.enum(SCORING_CRITERIA), z.number().int().min(0).max(100)),
  tierThresholds: z.object({ A: z.number().int().min(1).max(100), B: z.number().int().min(1).max(100), C: z.number().int().min(1).max(100) }).optional(),
});

export const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).optional() });
export const scoreReviewSchema = z.object({ decision: z.enum(['accept', 'override']), tier: z.enum(['A', 'B', 'C', 'D']).optional(), note: z.string().trim().max(500).optional() });

export const followUpRequestSchema = z.object({
  contactId: z.string().uuid(),
  channel: z.enum(['email', 'whatsapp']),
});
export const draftUpdateSchema = z.object({
  subject: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().min(2).max(4000),
});

// ---------------------------------------------------------------- DTOs

export interface BrainItemDto {
  id: string; section: BrainSection; trackId: string | null; title: string; body: string; fields: Record<string, unknown>;
  status: 'draft' | 'pending_confirmation' | 'approved' | 'archived'; sourceType: string; version: number;
  approvedByName: string | null; approvedAt: string | null; updatedAt: string; conflicts: { itemId: string; reason: string }[];
}
export interface BrainDocumentDto {
  id: string; title: string; filename: string | null; trustLevel: 'unverified' | 'approved' | 'suspicious'; injectionFlags: string[];
  chars: number; createdAt: string; approvedAt: string | null;
}
export interface BrainOverviewDto {
  items: BrainItemDto[]; documents: BrainDocumentDto[];
  coverage: { section: BrainSection; approved: number; total: number }[];
  conflicts: { a: string; b: string; reason: string }[];
}

export interface AiUsageDto { monthUsd: number; budgetUsd: number; runsThisMonth: number; enabled: boolean; providerReady: boolean }
export interface AiSettingsDto {
  enabled: boolean; voiceEnabled: boolean; monthlyBudgetUsd: number; agents: Record<AgentKey, { enabled: boolean }>; usage: AiUsageDto;
  scoring: { weights: Record<ScoringCriterion, number>; tierThresholds: { A: number; B: number; C: number }; version: number };
}
export interface AgentRunDto {
  id: string; agent: string; status: string; triggeredByName: string | null; entityType: string | null; entityId: string | null;
  model: string | null; inputTokens: number; outputTokens: number; costUsd: number; error: { code: string; message: string } | null;
  startedAt: string; finishedAt: string | null;
}
export interface AgentStepDto { id: number; kind: string; name: string | null; detail: Record<string, unknown>; createdAt: string }

export interface ApprovalDto {
  id: string; actionType: string; toolName: string; risk: string; payload: Record<string, unknown>; summary: string | null; reason: string | null;
  sources: unknown; confidence: number | null; requestedByType: string; requestedByName: string | null; agentRunId: string | null;
  entityType: string | null; entityId: string | null; status: string; decidedByName: string | null; decidedAt: string | null;
  decisionNote: string | null; executedAt: string | null; executionResult: unknown; expiresAt: string; createdAt: string;
}

export interface Evidence { ref: string; label: string }
export interface LeadScoreDto {
  id: string; accountId: string; score: number; tier: 'A' | 'B' | 'C' | 'D'; disqualified: boolean;
  criteria: { key: ScoringCriterion; score: number; weight: number; reason: string; evidence: Evidence[]; method: 'rule' | 'ai' }[];
  missingData: string[]; confidence: number; summary: string | null; reviewStatus: string; overrideTier: string | null; overrideNote: string | null;
  agentRunId: string | null; createdAt: string;
}

export interface VisitBriefDto {
  id: string; visitId: string; createdAt: string; agentRunId: string | null;
  content: {
    summary: string; whyTarget: string[]; goals: string[]; questions: string[];
    valuePoints: { text: string; source: Evidence }[];
    objections: { objection: string; response: string; source: Evidence }[];
    cautions: string[];
  };
  removed: { text: string; reason: string }[];
}

export interface MeetingInsightsDto {
  id: string; visitId: string; createdAt: string; agentRunId: string | null; summary: string;
  statedFacts: { type: string; value: string; quote: string }[];
  inferences: { type: string; value: string; reasoning: string; confidence: number }[];
  nextActions: { action: string; dueInDays: number | null }[];
  interestLevel: number | null; progressLikelihood: number | null; removed: { text: string; reason: string }[];
}

export interface MessageDraftDto {
  id: string; accountId: string; contactId: string; contactName: string; visitId: string | null; channel: 'email' | 'whatsapp';
  subject: string | null; body: string; status: string; forbiddenHits: string[]; approvalRequestId: string | null;
  sendLink: string | null; createdAt: string; sentAt: string | null;
}

export interface SessionDto { id: string; current: boolean; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string; mfaVerified: boolean }
export interface SecurityDto { mfaEnabled: boolean; emailVerified: boolean; sessions: SessionDto[] }

// ---------------------------------------------------------------- Prospecting

export const prospectSearchSchema = z.object({
  query: z.string().trim().min(5).max(300),
  city: z.string().trim().max(80).optional(),
  limit: z.number().int().min(1).max(10).default(5),
});
/** Text the company supplies (a directory page, an exhibitor list…) that it is allowed to use. */
export const prospectManualSchema = z.object({
  text: z.string().trim().min(20).max(20_000),
  sourceLabel: z.string().trim().min(2).max(200),
});
export const prospectRejectSchema = z.object({ reason: z.string().trim().min(2).max(300) });

export interface ProspectDto {
  id: string; searchId: string; name: string; websiteDomain: string | null; city: string | null; region: string | null;
  industry: string | null; phone: string | null; whyFit: string; fitEvidence: { text: string; ref: string; label: string }[];
  sourceUrl: string; sourceTitle: string | null; retrievedAt: string; confidence: number;
  duplicateOf: { id: string; name: string } | null; status: 'pending_review' | 'accepted' | 'rejected';
  accountId: string | null; reviewedByName: string | null; rejectReason: string | null; createdAt: string;
}
export interface ProspectSearchDto {
  id: string; query: string; city: string | null; source: 'web_search' | 'manual'; status: string; found: number;
  dropped: { name: string; reason: string }[]; requestedByName: string | null; createdAt: string;
}

// ---------------------------------------------------------------- Ask Rakan

export const assistantMessageSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(2000),
});
export interface AssistantMessageDto {
  id: number; role: 'user' | 'assistant'; content: string;
  toolCalls: { tool: string; ok: boolean; summary: string }[]; links: { label: string; href: string }[]; createdAt: string;
}
export interface AssistantConversationDto { id: string; title: string; updatedAt: string; messages?: AssistantMessageDto[] }

// ---------------------------------------------------------------- Voice (Rakan's spokesperson voice)

/** Statement the voice owner agrees to before their voice is cloned (stored with the voice). */
export const VOICE_CONSENT_STATEMENT =
  'أقرّ بأن هذا التسجيل بصوتي أنا، وأوافق على استخدامه لإنشاء صوت مُولَّد بالذكاء الاصطناعي يمثّل راكان متحدثاً رسمياً داخل المنصة، وأعلم أنني أستطيع حذفه في أي وقت.';

export interface VoiceStatusDto {
  /** A voice provider key is configured on the server. */
  providerReady: boolean;
  /** The spokesperson voice has been set up by the platform. */
  voiceConfigured: boolean;
  /** The company allows voice (company setting + AI on + assistant on). */
  enabled: boolean;
  budgetReached: boolean;
  /** Replies can be read aloud in the spokesperson voice. */
  canSpeak: boolean;
  /** Speech can be turned into text. */
  canListen: boolean;
  voiceName: string | null;
  maxSeconds: number;
  pricing: { ttsUsdPer1kChars: number; sttUsdPerMinute: number };
}

export const SPEECH_STYLES = ['saudi', 'msa'] as const;
export type SpeechStyle = (typeof SPEECH_STYLES)[number];
export const libraryVoiceSchema = z.object({
  voiceId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,64}$/),
  displayName: z.string().trim().min(2).max(60),
});
export const speechStyleSchema = z.object({ style: z.enum(SPEECH_STYLES) });

export interface PlatformVoiceDto {
  providerReady: boolean;
  provider: string;
  configured: boolean;
  /** 'cloned' = a consenting person's voice; 'library' = a ready-made provider voice; 'env' = server default. */
  kind: 'cloned' | 'library' | 'env' | null;
  displayName: string | null;
  speechStyle: SpeechStyle;
  consentStatement: string;
  consentedByName: string | null;
  consentedAt: string | null;
  sampleBytes: number | null;
  pricing: { ttsUsdPer1kChars: number; sttUsdPerMinute: number };
}
