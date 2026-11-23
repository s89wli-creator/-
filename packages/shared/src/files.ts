import { z } from 'zod';

export const ATTACHMENT_ENTITIES = ['account', 'visit', 'proposal'] as const;
export type AttachmentEntityKey = (typeof ATTACHMENT_ENTITIES)[number];
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Accepted types (checked by file content on the server, not by the name or the browser). */
export const ATTACHMENT_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'heic', 'docx', 'xlsx', 'pptx', 'csv', 'txt'] as const;

export const attachmentListQuerySchema = z.object({ entityType: z.enum(ATTACHMENT_ENTITIES), entityId: z.string().uuid() });
export const attachmentUploadSchema = attachmentListQuerySchema;

export interface AttachmentDto {
  id: string; entityType: AttachmentEntityKey; entityId: string; filename: string; mimeType: string; sizeBytes: number;
  uploadedByName: string | null; createdAt: string;
}

// ---------------------------------------------------------------- Web Push

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'https only'),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});
export const pushUnsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });
export interface PushConfigDto { enabled: boolean; publicKey: string | null; devices: number }
