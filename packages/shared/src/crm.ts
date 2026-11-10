import { z } from 'zod';

const uuid = z.string().uuid();
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const name = z.string().trim().min(2).max(200);

// ---------------- settings ----------------

export const trackSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, 'lowercase latin key'),
  name: z.string().trim().min(2).max(80),
  description: optText(500),
});
export type TrackInput = z.infer<typeof trackSchema>;

export const STAGE_CATEGORIES = ['open', 'won', 'lost', 'postponed'] as const;
export type StageCategory = (typeof STAGE_CATEGORIES)[number];

export const stageSchema = z.object({
  id: uuid.optional(),
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/),
  name: z.string().trim().min(1).max(60),
  category: z.enum(STAGE_CATEGORIES),
  winProbability: z.number().min(0).max(1).nullable().optional(),
});

export const pipelineSchema = z.object({
  name: z.string().trim().min(2).max(80),
  trackId: uuid.nullable().optional(),
  stages: z
    .array(stageSchema)
    .min(2)
    .max(20)
    .refine((s) => new Set(s.map((x) => x.key)).size === s.length, 'stage keys must be unique')
    .refine((s) => s.some((x) => x.category === 'won') && s.some((x) => x.category === 'lost'), 'needs a won and a lost stage'),
});
export type PipelineInput = z.infer<typeof pipelineSchema>;

export const OUTCOME_KINDS = ['win', 'loss', 'postpone', 'disqualify'] as const;
export const outcomeReasonSchema = z.object({
  kind: z.enum(OUTCOME_KINDS),
  label: z.string().trim().min(2).max(120),
  isActive: z.boolean().optional(),
});

export const CUSTOM_FIELD_ENTITIES = ['account', 'contact', 'opportunity'] as const;
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'select', 'boolean'] as const;
export const customFieldSchema = z
  .object({
    entity: z.enum(CUSTOM_FIELD_ENTITIES),
    key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/),
    label: z.string().trim().min(1).max(80),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    trackId: uuid.nullable().optional(),
  })
  .refine((f) => f.type !== 'select' || (f.options && f.options.length > 0), { message: 'select needs options', path: ['options'] });
export type CustomFieldInput = z.infer<typeof customFieldSchema>;

// ---------------- accounts & contacts ----------------

export const ACCOUNT_STATUSES = ['active', 'customer', 'disqualified', 'archived'] as const;
export const LEAD_SOURCES = ['manual', 'import', 'referral', 'inbound', 'prospecting', 'event', 'other'] as const;

export const accountSchema = z.object({
  name,
  legalName: optText(200),
  crNumber: z.string().trim().regex(/^\d{10}$/).nullable().optional(),
  vatNumber: z.string().trim().regex(/^3\d{13}3$/).nullable().optional(),
  website: optText(200),
  phone: optText(30),
  industry: optText(120),
  sizeBand: z.enum(['micro', 'small', 'medium', 'large', 'enterprise']).nullable().optional(),
  region: optText(80),
  city: optText(80),
  address: optText(300),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  trackId: uuid.nullable().optional(),
  territoryId: uuid.nullable().optional(),
  ownerMembershipId: uuid.nullable().optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  disqualifyReason: optText(300),
  leadSource: z.enum(LEAD_SOURCES).optional(),
  leadSourceDetail: optText(200),
  customFields: z.record(z.unknown()).optional(),
});
export type AccountInput = z.infer<typeof accountSchema>;
export const accountUpdateSchema = accountSchema.partial();

export const accountQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  trackId: uuid.optional(),
  ownerMembershipId: z.union([uuid, z.literal('unassigned'), z.literal('me')]).optional(),
  territoryId: uuid.optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  city: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['name', 'created_desc', 'activity_desc']).default('activity_desc'),
});
export type AccountQuery = z.infer<typeof accountQuerySchema>;

export const contactSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  jobTitle: optText(120),
  phone: optText(30),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  preferredChannel: z.enum(['phone', 'whatsapp', 'email', 'visit']).nullable().optional(),
  isPrimary: z.boolean().optional(),
  customFields: z.record(z.unknown()).optional(),
});
export type ContactInput = z.infer<typeof contactSchema>;

export const dncSchema = z.object({
  doNotContact: z.boolean(),
  reason: optText(300),
});

// ---------------- opportunities ----------------

export const opportunitySchema = z.object({
  accountId: uuid,
  title: z.string().trim().min(2).max(200),
  pipelineId: uuid.optional(),
  stageId: uuid.optional(),
  ownerMembershipId: uuid.nullable().optional(),
  amount: z.number().min(0).max(1e12).nullable().optional(),
  expectedCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  customFields: z.record(z.unknown()).optional(),
});
export type OpportunityInput = z.infer<typeof opportunitySchema>;
export const opportunityUpdateSchema = opportunitySchema.omit({ accountId: true, pipelineId: true, stageId: true }).partial();

export const moveStageSchema = z.object({
  stageId: uuid,
  outcomeReasonId: uuid.nullable().optional(),
  note: optText(1000),
});

// ---------------- tasks & notes ----------------

export const TASK_TYPES = ['todo', 'call', 'follow_up', 'send_proposal', 'meeting', 'payment_reminder'] as const;
export const taskSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: optText(2000),
  type: z.enum(TASK_TYPES).default('todo'),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  assigneeMembershipId: uuid.nullable().optional(),
  accountId: uuid.nullable().optional(),
  opportunityId: uuid.nullable().optional(),
});
export type TaskInput = z.infer<typeof taskSchema>;
export const taskUpdateSchema = taskSchema.partial().extend({ status: z.enum(['open', 'done', 'cancelled']).optional() });
export const taskQuerySchema = z.object({
  view: z.enum(['mine', 'overdue', 'today', 'upcoming', 'all', 'done']).default('mine'),
  accountId: uuid.optional(),
  assigneeMembershipId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const noteSchema = z.object({ body: z.string().trim().min(1).max(5000) });

// ---------------- visits ----------------

export const VISIT_OUTCOMES = ['interested', 'needs_follow_up', 'not_interested', 'not_met'] as const;
export const NEXT_STEPS = ['send_proposal', 'another_visit', 'call', 'none'] as const;

export const visitSchema = z
  .object({
    accountId: uuid,
    opportunityId: uuid.nullable().optional(),
    repMembershipId: uuid.optional(),
    purpose: optText(300),
    scheduledStart: z.string().datetime({ offset: true }),
    scheduledEnd: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((v) => !v.scheduledEnd || v.scheduledEnd > v.scheduledStart, { message: 'end must be after start', path: ['scheduledEnd'] });
export type VisitInput = z.infer<typeof visitSchema>;

export const visitRescheduleSchema = z.object({
  scheduledStart: z.string().datetime({ offset: true }),
  scheduledEnd: z.string().datetime({ offset: true }).nullable().optional(),
  repMembershipId: uuid.optional(),
  purpose: optText(300),
});

export const geoSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(100_000).optional(),
  /** When the action really happened (set by the field app when it was recorded offline). */
  occurredAt: z.string().datetime({ offset: true }).optional(),
});

export const visitOutcomeSchema = z.object({
  outcome: z.enum(VISIT_OUTCOMES),
  interestLevel: z.number().int().min(1).max(5).nullable().optional(),
  nextStep: z.enum(NEXT_STEPS),
  nextFollowUpAt: z.string().datetime({ offset: true }).nullable().optional(),
  notes: optText(5000),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});
export type VisitOutcomeInput = z.infer<typeof visitOutcomeSchema>;

export const visitQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  repMembershipId: uuid.optional(),
  accountId: uuid.optional(),
});

// ---------------- reports ----------------

export const dashboardQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  trackId: uuid.optional(),
});

// ---------------- import ----------------

/** Target fields an account import can map to. `contact.*` creates a primary contact. */
export const ACCOUNT_IMPORT_FIELDS = [
  'name', 'legalName', 'crNumber', 'vatNumber', 'website', 'phone', 'industry', 'region', 'city', 'address',
  'lat', 'lng', 'track', 'contact.fullName', 'contact.jobTitle', 'contact.phone', 'contact.email', 'note',
] as const;
export type AccountImportField = (typeof ACCOUNT_IMPORT_FIELDS)[number];

export const importMappingSchema = z.object({
  /** target field (or custom.<key>) -> source column header */
  mapping: z.record(z.string().max(200)),
  defaults: z
    .object({ trackId: uuid.nullable().optional(), ownerMembershipId: uuid.nullable().optional(), leadSourceDetail: optText(200) })
    .default({}),
  dataPermissionConfirmed: z.literal(true, { errorMap: () => ({ message: 'You must confirm you are allowed to use this data' }) }),
});
export type ImportMappingInput = z.infer<typeof importMappingSchema>;

export const importRowResolutionSchema = z.object({ resolution: z.enum(['create', 'merge', 'skip']) });

// ---------------------------------------------------------------- Phase 5: visit recordings

export const RECORDING_MIME_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/x-m4a'] as const;
export const RECORDING_CHUNK_BYTES = 1024 * 1024;
export const RECORDING_MAX_BYTES = 50 * 1024 * 1024;
export const recordingStartSchema = z.object({
  mimeType: z.string().trim().max(60).transform((m) => m.split(';')[0]!.toLowerCase()).pipe(z.enum(RECORDING_MIME_TYPES)),
  totalChunks: z.number().int().min(1).max(50),
  durationSec: z.number().int().min(1).max(3600).optional(),
  consent: z.literal(true),
});
export const transcriptSchema = z.object({ transcript: z.string().trim().min(1).max(20_000) });
export interface RecordingDto {
  id: string; visitId: string; mimeType: string; status: 'uploading' | 'ready' | 'deleted'; totalChunks: number; receivedChunks: number[];
  sizeBytes: number; durationSec: number | null; transcript: string | null; transcriptStatus: string; uploadedByName: string | null;
  deleteAfter: string; createdAt: string;
}
