'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { ACCOUNT_IMPORT_FIELDS, type ImportJobDto, type ImportRowDto } from '@rakan/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, LoadingState, NoPermission, PageHeader, Pagination, Select, Tabs } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useCrmSettings, useMembers } from '@/lib/crm';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n, useInvalidate } from '@/lib/providers';

type Filter = 'all' | 'duplicates' | 'invalid' | 'warnings';

async function upload(file: File): Promise<ImportJobDto> {
  const csrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('rakan_csrf='))?.split('=')[1] ?? '');
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/crm/imports', { method: 'POST', body: fd, headers: { 'x-csrf-token': csrf }, credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error?.code ?? (res.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'UNKNOWN'), body.error?.message ?? '');
  return body as ImportJobDto;
}

function Steps({ current }: { current: number }) {
  const { t } = useI18n();
  const steps: MessageKey[] = ['import.step.upload', 'import.step.map', 'import.step.review', 'import.step.done'];
  return (
    <ol className="mb-6 flex flex-wrap gap-2 text-sm">
      {steps.map((s, i) => (
        <li key={s} className={`flex items-center gap-2 rounded-full px-3 py-1 ${i === current ? 'bg-brand-600 text-white' : i < current ? 'bg-brand-50 text-brand-700' : 'bg-ink-100 text-ink-500'}`}>
          <span className="font-semibold">{i + 1}</span> {t(s)}
        </li>
      ))}
    </ol>
  );
}

export default function ImportPage() {
  const { t, err } = useI18n();
  const can = useCan();
  const invalidate = useInvalidate();
  const settings = useCrmSettings();
  const members = useMembers();
  const [job, setJob] = useState<ImportJobDto | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('duplicates');
  const [page, setPage] = useState(1);
  const [permissionMissing, setPermissionMissing] = useState(false);

  const up = useMutation({
    mutationFn: upload,
    onSuccess: (j) => {
      setJob(j);
      setMapping(j.suggestedMapping);
    },
  });
  const map = useMutation({
    mutationFn: (body: object) => api<ImportJobDto>(`/crm/imports/${job!.id}/mapping`, { method: 'PUT', body }),
    onSuccess: (j) => {
      setJob(j);
      setFilter(j.stats.duplicates ? 'duplicates' : j.stats.invalid ? 'invalid' : 'all');
      setPage(1);
    },
  });
  const rows = useQuery({
    queryKey: ['import-rows', job?.id, filter, page, job?.status],
    queryFn: () => api<{ items: ImportRowDto[]; total: number }>(`/crm/imports/${job!.id}/rows?filter=${filter}&page=${page}`),
    enabled: job?.status === 'review',
  });
  const resolve = useMutation({
    mutationFn: ({ rowId, resolution }: { rowId: number; resolution: string }) => api(`/crm/imports/${job!.id}/rows/${rowId}`, { method: 'PATCH', body: { resolution } }),
    onSuccess: () => rows.refetch(),
  });
  const execute = useMutation({
    mutationFn: () => api<ImportJobDto>(`/crm/imports/${job!.id}/execute`, { method: 'POST' }),
    onSuccess: (j) => {
      setJob(j);
      invalidate('accounts');
    },
  });
  const cancel = useMutation({
    mutationFn: () => api<ImportJobDto>(`/crm/imports/${job!.id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      setJob(null);
      setFile(null);
    },
  });

  if (!can('crm.import')) return <NoPermission />;
  const step = !job ? 0 : job.status === 'uploaded' ? 1 : job.status === 'review' ? 2 : 3;
  const customDefs = (settings.data?.customFields ?? []).filter((f) => f.entity === 'account');
  const fields: { key: string; label: string }[] = [
    ...ACCOUNT_IMPORT_FIELDS.map((f) => ({ key: f, label: t(`import.field.${f}` as MessageKey) })),
    ...customDefs.map((d) => ({ key: `custom.${d.key}`, label: d.label })),
  ];

  function submitMapping(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (fd.get('permission') !== 'on') return setPermissionMissing(true);
    setPermissionMissing(false);
    map.mutate({
      mapping,
      defaults: { trackId: String(fd.get('trackId') || '') || null, ownerMembershipId: String(fd.get('ownerMembershipId') || '') || null },
      dataPermissionConfirmed: fd.get('permission') === 'on',
    });
  }

  const reasonLabel = (r: string | null) => (r ? t(`accounts.dupReason.${r}` as MessageKey) : '');
  const errLabel = (code: string) => t(`import.err.${code.replace('warning:', '')}` as MessageKey);
  const fieldLabel = (f: string) => fields.find((x) => x.key === f)?.label ?? f;

  return (
    <>
      <Link href="/accounts" className="text-sm text-brand-700 hover:underline">← {t('accounts.title')}</Link>
      <PageHeader title={t('import.title')} subtitle={t('import.subtitle')} />
      <Steps current={step} />

      {step === 0 && (
        <Card className="space-y-4 p-5">
          {up.error && <Alert tone="error">{err(up.error)}</Alert>}
          <label className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-ink-200 p-6 text-center hover:border-brand-500">
            <span className="font-medium">{file ? file.name : t('import.choose')}</span>
            <span className="text-xs text-ink-500">.xlsx · .csv</span>
            <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <div className="flex justify-end">
            <Button disabled={!file} loading={up.isPending} onClick={() => file && up.mutate(file)}>{t('import.upload')}</Button>
          </div>
        </Card>
      )}

      {step === 1 && job && (
        <form onSubmit={submitMapping} noValidate className="space-y-4">
          <Alert tone="info">{t('import.rowsFound', { rows: job.stats.rows ?? 0, cols: job.headers.length, file: job.filename })}</Alert>
          {map.error && <Alert tone="error">{err(map.error)}</Alert>}
          {permissionMissing && <Alert tone="error">{t('errors.PERMISSION_NOT_CONFIRMED')}</Alert>}
          <Card>
            <div className="grid grid-cols-2 gap-2 border-b border-ink-100 px-4 py-2 text-xs font-medium text-ink-500">
              <span>{t('import.field')}</span>
              <span>{t('import.column')}</span>
            </div>
            <ul className="divide-y divide-ink-100">
              {fields.map((f) => (
                <li key={f.key} className="grid grid-cols-2 items-center gap-2 px-4 py-2">
                  <label htmlFor={`map-${f.key}`} className="text-sm">{f.label}</label>
                  <Select id={`map-${f.key}`} value={mapping[f.key] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}>
                    <option value="">{t('import.notMapped')}</option>
                    {job.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </Select>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="grid gap-4 p-4 sm:grid-cols-2">
            <p className="text-sm font-medium sm:col-span-2">{t('import.defaults')}</p>
            {!!settings.data?.tracks.length && (
              <Field label={t('import.defaultTrack')} htmlFor="def-track" optional>
                <Select id="def-track" name="trackId" defaultValue="">
                  <option value="">—</option>
                  {settings.data.tracks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label={t('import.defaultOwner')} htmlFor="def-owner" optional>
              <Select id="def-owner" name="ownerMembershipId" defaultValue="">
                <option value="">{t('common.unassigned')}</option>
                {members.data?.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
              </Select>
            </Field>
          </Card>
          <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <input type="checkbox" name="permission" aria-invalid={permissionMissing} className="mt-0.5 size-5 shrink-0 accent-brand-600" />
            {t('import.permission')}
          </label>
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()}>{t('import.cancel')}</Button>
            <Button type="submit" loading={map.isPending}>{t('import.analyze')}</Button>
          </div>
        </form>
      )}

      {step === 2 && job && (
        <div className="space-y-4">
          <Alert tone="info">{t('import.stats', { valid: job.stats.valid ?? 0, invalid: job.stats.invalid ?? 0, duplicates: job.stats.duplicates ?? 0, warnings: job.stats.warnings ?? 0 })}</Alert>
          {(execute.error || resolve.error) && <Alert tone="error">{err(execute.error ?? resolve.error)}</Alert>}
          <Tabs<Filter>
            label={t('import.step.review')}
            value={filter}
            onChange={(f) => { setFilter(f); setPage(1); }}
            tabs={[
              { id: 'duplicates', label: t('import.filter.duplicates'), count: job.stats.duplicates },
              { id: 'invalid', label: t('import.filter.invalid'), count: job.stats.invalid },
              { id: 'warnings', label: t('import.filter.warnings'), count: job.stats.warnings },
              { id: 'all', label: t('import.filter.all'), count: job.stats.rows },
            ]}
          />
          <Card>
            {rows.isLoading ? <LoadingState /> : !rows.data?.items.length ? <EmptyState>—</EmptyState> : (
              <ul className="divide-y divide-ink-100">
                {rows.data.items.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="w-10 shrink-0 text-xs text-ink-400">#{r.rowNumber}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{String(r.normalized?.name ?? r.raw[mapping.name ?? ''] ?? '—') || '—'}</p>
                      {r.duplicateReason && (
                        <p className="text-sm text-amber-800">{t('import.matches', { name: r.duplicateOfName ?? '' })} · {reasonLabel(r.duplicateReason)}</p>
                      )}
                      {r.errors?.map((e) => (
                        <p key={e.field + e.code} className={`text-xs ${e.code.startsWith('warning:') ? 'text-ink-500' : 'text-red-700'}`}>
                          {fieldLabel(e.field)}: {errLabel(e.code)}
                        </p>
                      ))}
                    </div>
                    {r.resolution === null ? (
                      <Badge tone="muted">{t('import.res.invalid')}</Badge>
                    ) : (
                      <Select
                        aria-label={t('import.decision')}
                        className="w-44"
                        value={r.resolution}
                        disabled={resolve.isPending}
                        onChange={(e) => resolve.mutate({ rowId: r.id, resolution: e.target.value })}
                      >
                        <option value="create">{t('import.res.create')}</option>
                        {r.duplicateOfId && <option value="merge">{t('import.res.merge')}</option>}
                        <option value="skip">{t('import.res.skip')}</option>
                      </Select>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Pagination page={page} total={rows.data?.total ?? 0} pageSize={50} onPage={setPage} />
          </Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()}>{t('import.cancel')}</Button>
            <Button loading={execute.isPending} onClick={() => execute.mutate()}>{t('import.execute')}</Button>
          </div>
        </div>
      )}

      {step === 3 && job && (
        <Card className="space-y-4 p-5">
          <Alert tone="success">{t('import.done', { created: job.stats.created ?? 0, merged: job.stats.merged ?? 0, skipped: job.stats.skipped ?? 0 })}</Alert>
          <Link href="/accounts" className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white">{t('import.viewAccounts')}</Link>
        </Card>
      )}
    </>
  );
}
