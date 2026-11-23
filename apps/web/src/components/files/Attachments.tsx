'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ATTACHMENT_EXTENSIONS, ATTACHMENT_MAX_BYTES, type AttachmentDto, type AttachmentEntityKey } from '@rakan/shared';
import { useRef } from 'react';
import { useConfirm, useToast } from '@/components/feedback';
import { Icon } from '@/components/icons';
import { Alert, Button, Card, CardHeading, EmptyState, IconButton, LoadingState, formatBytes, formatDate } from '@/components/ui';
import { ApiError, api, apiForm } from '@/lib/api';
import { useI18n } from '@/lib/providers';

/** Files on a customer, visit or proposal. Access follows the record (checked by the server). */
export function Attachments({ entityType, entityId, canWrite, bare }: { entityType: AttachmentEntityKey; entityId: string; canWrite: boolean; bare?: boolean }) {
  const { t, err, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const key = ['attachments', entityType, entityId];
  const q = useQuery({ queryKey: key, queryFn: () => api<AttachmentDto[]>(`/crm/attachments?entityType=${entityType}&entityId=${entityId}`) });
  const add = useMutation({
    mutationFn: (file: File) => {
      if (file.size > ATTACHMENT_MAX_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'File too large');
      const fd = new FormData();
      fd.set('entityType', entityType);
      fd.set('entityId', entityId);
      fd.set('file', file);
      return apiForm<AttachmentDto>('/crm/attachments', fd);
    },
    onSuccess: () => { remove.reset(); void qc.invalidateQueries({ queryKey: key }); toast(t('files.uploaded')); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/crm/attachments/${id}`, { method: 'DELETE' }),
    onSuccess: () => { add.reset(); void qc.invalidateQueries({ queryKey: key }); toast(t('files.deleted')); },
  });

  const body = (
    <>
      {(add.error || remove.error) && <div className="mb-3"><Alert tone="error">{err(add.error ?? remove.error)}</Alert></div>}
      {q.isLoading ? <LoadingState rows={2} /> : !q.data?.length ? <EmptyState icon="file">{t('files.empty')}</EmptyState> : (
        <ul className="divide-y divide-line-soft">
          {q.data.map((f) => (
            <li key={f.id} className="flex items-center gap-3 py-2.5">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-subtle text-fg-sub" aria-hidden><Icon name="file" size={20} /></span>
              <a href={`/api/crm/attachments/${f.id}/file`} download className="min-w-0 flex-1" aria-label={t('files.download', { name: f.filename })}>
                <span className="block truncate font-medium text-brand-700 hover:underline">{f.filename}</span>
                <span className="block text-xs text-fg-muted">{formatBytes(f.sizeBytes)} · {t('files.by', { name: f.uploadedByName ?? '—', date: formatDate(f.createdAt, locale) })}</span>
              </a>
              {canWrite && (
                <IconButton icon="trash" label={t('files.delete')} disabled={remove.isPending}
                  onClick={async () => { if (await confirm({ title: t('files.delete'), body: t('files.deleteConfirm', { name: f.filename }) })) remove.mutate(f.id); }} />
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <div className="mt-3 space-y-1 border-t border-line-soft pt-3">
          <input ref={input} type="file" className="sr-only" aria-label={t('files.upload')} accept={ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(',')}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) add.mutate(f); e.target.value = ''; }} />
          <Button variant="secondary" icon="upload" loading={add.isPending} onClick={() => input.current?.click()}>{t('files.upload')}</Button>
          <p className="text-xs text-fg-muted">{t('files.hint')}</p>
        </div>
      )}
    </>
  );
  if (bare) return <div className="p-5">{body}</div>;
  return <Card className="p-5"><CardHeading>{t('files.title')}</CardHeading>{body}</Card>;
}
