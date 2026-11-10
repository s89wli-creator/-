'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, OUTCOME_KINDS, STAGE_CATEGORIES, customFieldSchema, trackSchema,
  type CrmSettingsDto, type PipelineDto, type StageCategory,
} from '@rakan/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, ErrorState, Field, Input, LoadingState, NoPermission, PageHeader, Select } from '@/components/ui';
import { useConfirm, useToast } from '@/components/feedback';
import { api } from '@/lib/api';
import { useCrmSettings } from '@/lib/crm';
import { validate, type FieldErrors } from '@/lib/forms';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n } from '@/lib/providers';

type EditableStage = { id?: string; key: string; name: string; category: StageCategory };

function slug(name: string, existing: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  let key = /^[a-z][a-z0-9_]+$/.test(base) ? base : 'stage';
  let i = 2;
  while (existing.includes(key)) key = `${base && /^[a-z]/.test(base) ? base : 'stage'}_${i++}`;
  return key;
}

function StageEditor({ pipeline, onSaved }: { pipeline: PipelineDto; onSaved: (s: CrmSettingsDto) => void }) {
  const { t, err } = useI18n();
  const [stages, setStages] = useState<EditableStage[]>([]);
  useEffect(() => setStages(pipeline.stages.map(({ id, key, name, category }) => ({ id, key, name, category }))), [pipeline]);
  const save = useMutation({
    mutationFn: () => api<CrmSettingsDto>(`/crm/pipelines/${pipeline.id}`, { method: 'PUT', body: { name: pipeline.name, stages } }),
    onSuccess: onSaved,
  });
  const update = (i: number, patch: Partial<EditableStage>) => setStages((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) =>
    setStages((s) => {
      const c = [...s];
      [c[i], c[i + d]] = [c[i + d]!, c[i]!];
      return c;
    });
  return (
    <div className="space-y-3">
      {save.error && <Alert tone="error">{err(save.error)}</Alert>}
      <ol className="space-y-2">
        {stages.map((s, i) => (
          <li key={s.id ?? s.key} className="flex flex-wrap items-center gap-2">
            <span className="w-6 text-xs text-fg-muted">{i + 1}</span>
            <Input aria-label={t('crmSettings.stageName')} className="min-w-40 flex-1" value={s.name} onChange={(e) => update(i, { name: e.target.value })} />
            <Select aria-label={t('crmSettings.category')} className="w-32" value={s.category} onChange={(e) => update(i, { category: e.target.value as StageCategory })}>
              {STAGE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`crmSettings.category.${c}`)}</option>)}
            </Select>
            <Button variant="ghost" className="min-h-9 px-2" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('crmSettings.moveUp')}>↑</Button>
            <Button variant="ghost" className="min-h-9 px-2" disabled={i === stages.length - 1} onClick={() => move(i, 1)} aria-label={t('crmSettings.moveDown')}>↓</Button>
            <Button variant="ghost" className="min-h-9 px-2 text-danger" disabled={stages.length <= 2} onClick={() => setStages((x) => x.filter((_, j) => j !== i))} aria-label={t('common.delete')}>✕</Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="secondary" onClick={() => setStages((s) => [...s, { key: slug('stage', s.map((x) => x.key)), name: '', category: 'open' }])}>{t('crmSettings.addStage')}</Button>
        <Button loading={save.isPending} disabled={stages.some((s) => !s.name.trim())} onClick={() => save.mutate()}>{t('common.save')}</Button>
      </div>
    </div>
  );
}

function usePostSettings(path: string, onSaved: (s: CrmSettingsDto) => void) {
  return useMutation({ mutationFn: (body: object) => api<CrmSettingsDto>(path, { method: 'POST', body }), onSuccess: onSaved });
}

export default function CrmSettingsPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const { t, err } = useI18n();
  const can = useCan();
  const qc = useQueryClient();
  const settings = useCrmSettings();
  const [pipelineId, setPipelineId] = useState('');
  const [trackErrors, setTrackErrors] = useState<FieldErrors>({});
  const [cfErrors, setCfErrors] = useState<FieldErrors>({});
  const [cfType, setCfType] = useState<string>('text');
  const onSaved = (s: CrmSettingsDto) => {
    qc.setQueryData(['crm-settings'], s);
    toast(t('common.saveSuccess'));
  };
  const createTrack = usePostSettings('/crm/tracks', onSaved);
  const createReason = usePostSettings('/crm/reasons', onSaved);
  const createField = usePostSettings('/crm/custom-fields', onSaved);
  const toggleReason = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api<CrmSettingsDto>(`/crm/reasons/${id}`, { method: 'PATCH', body: { isActive } }),
    onSuccess: onSaved,
  });
  const deleteField = useMutation({ mutationFn: (id: string) => api<CrmSettingsDto>(`/crm/custom-fields/${id}`, { method: 'DELETE' }), onSuccess: onSaved });

  useEffect(() => {
    if (!pipelineId && settings.data) setPipelineId(settings.data.pipelines.find((p) => p.isDefault)?.id ?? '');
  }, [settings.data, pipelineId]);

  if (!can('crm.settings.manage')) return <NoPermission />;
  if (settings.isLoading) return <LoadingState card />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  const s = settings.data!;
  const trackName = (id: string | null) => s.tracks.find((x) => x.id === id)?.name;
  const pipeline = s.pipelines.find((p) => p.id === pipelineId);

  function submitTrack(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const v = validate(trackSchema, { key: String(fd.get('key') ?? '').trim(), name: String(fd.get('name') ?? '').trim() });
    setTrackErrors(v.ok ? {} : v.errors);
    if (v.ok) createTrack.mutate(v.data, { onSuccess: () => form.reset() });
  }
  function submitReason(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const label = String(fd.get('label') ?? '').trim();
    if (label.length >= 2) createReason.mutate({ kind: fd.get('kind'), label }, { onSuccess: () => form.reset() });
  }
  function submitField(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const options = String(fd.get('options') ?? '').split(/[,،]/).map((x) => x.trim()).filter(Boolean);
    const v = validate(customFieldSchema, {
      entity: fd.get('entity'), key: String(fd.get('key') ?? '').trim(), label: String(fd.get('label') ?? '').trim(), type: cfType,
      ...(cfType === 'select' ? { options } : {}), trackId: String(fd.get('trackId') || '') || null,
    });
    setCfErrors(v.ok ? {} : v.errors);
    if (v.ok) createField.mutate(v.data, { onSuccess: () => form.reset() });
  }

  return (
    <>
      <PageHeader title={t('crmSettings.title')} />
      <div className="space-y-6">
        <Card className="space-y-4 p-5">
          <div>
            <h2 className="font-semibold">{t('crmSettings.tracks')}</h2>
            <p className="text-sm text-fg-muted">{t('crmSettings.tracksHint')}</p>
          </div>
          <div className="flex flex-wrap gap-2">{s.tracks.map((tr) => <Badge key={tr.id} tone="brand">{tr.name}</Badge>)}</div>
          {createTrack.error && <Alert tone="error">{err(createTrack.error)}</Alert>}
          <form onSubmit={submitTrack} noValidate className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label={t('crmSettings.trackName')} htmlFor="tr-name" error={trackErrors.name && t(trackErrors.name.key, trackErrors.name.vars)}>
              <Input id="tr-name" name="name" />
            </Field>
            <Field label={t('crmSettings.trackKey')} htmlFor="tr-key" error={trackErrors.key && t('form.invalid')}>
              <Input id="tr-key" name="key" dir="ltr" placeholder="shippers" />
            </Field>
            <Button type="submit" loading={createTrack.isPending}>{t('common.add')}</Button>
          </form>
        </Card>

        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">{t('crmSettings.pipelines')}</h2>
            {s.pipelines.length > 1 && (
              <Select aria-label={t('pipeline.choose')} className="w-56" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)}>
                {s.pipelines.map((p) => <option key={p.id} value={p.id}>{p.trackId ? trackName(p.trackId) : p.name}</option>)}
              </Select>
            )}
          </div>
          {pipeline && <StageEditor pipeline={pipeline} onSaved={onSaved} />}
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="font-semibold">{t('crmSettings.reasons')}</h2>
          {(createReason.error || toggleReason.error) && <Alert tone="error">{err(createReason.error ?? toggleReason.error)}</Alert>}
          <div className="grid gap-4 md:grid-cols-2">
            {OUTCOME_KINDS.map((k) => (
              <div key={k}>
                <h3 className="mb-2 text-sm font-medium text-fg-sub">{t(`crmSettings.reasonKind.${k}` as MessageKey)}</h3>
                <ul className="flex flex-wrap gap-2">
                  {s.reasons.filter((r) => r.kind === k).map((r) => (
                    <li key={r.id}>
                      <button
                        className={`min-h-11 rounded-full border px-4 text-sm transition-colors duration-150 hover:border-line-strong ${r.isActive ? 'border-line bg-surface' : 'border-dashed border-line text-fg-muted line-through'}`}
                        title={r.isActive ? t('team.disable') : t('team.enable')}
                        onClick={() => toggleReason.mutate({ id: r.id, isActive: !r.isActive })}
                      >
                        {r.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <form onSubmit={submitReason} className="grid gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-end">
            <Select aria-label={t('crmSettings.category')} name="kind" defaultValue="loss">
              {OUTCOME_KINDS.map((k) => <option key={k} value={k}>{t(`crmSettings.reasonKind.${k}` as MessageKey)}</option>)}
            </Select>
            <Input aria-label={t('crmSettings.newReason')} name="label" placeholder={t('crmSettings.newReason')} />
            <Button type="submit" loading={createReason.isPending}>{t('common.add')}</Button>
          </form>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="font-semibold">{t('crmSettings.customFields')}</h2>
          {(createField.error || deleteField.error) && <Alert tone="error">{err(createField.error ?? deleteField.error)}</Alert>}
          {!!s.customFields.length && (
            <ul className="divide-y divide-line-soft rounded-lg border border-line-soft">
              {s.customFields.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="flex-1 font-medium">{f.label}</span>
                  <Badge>{t(`crmSettings.cfEntity.${f.entity}` as MessageKey)}</Badge>
                  <Badge tone="muted">{t(`crmSettings.cfType.${f.type}` as MessageKey)}</Badge>
                  {f.trackId && <Badge tone="brand">{trackName(f.trackId)}</Badge>}
                  <Button variant="ghost" className="min-h-9 px-2 text-danger" onClick={() => void confirm({ title: t('crmSettings.cfConfirmDelete', { name: f.label }), tone: 'danger', confirmLabel: t('common.delete') }).then((ok) => ok && deleteField.mutate(f.id))}>
                    {t('common.delete')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={submitField} noValidate className="grid gap-3 sm:grid-cols-2">
            <Field label={t('crmSettings.cfLabel')} htmlFor="cf-label" error={cfErrors.label && t(cfErrors.label.key, cfErrors.label.vars)}>
              <Input id="cf-label" name="label" />
            </Field>
            <Field label={t('crmSettings.cfKey')} htmlFor="cf-key" error={cfErrors.key && t('form.invalid')}>
              <Input id="cf-key" name="key" dir="ltr" placeholder="fleet_size" />
            </Field>
            <Field label={t('crmSettings.cfEntity')} htmlFor="cf-entity">
              <Select id="cf-entity" name="entity" defaultValue="account">
                {CUSTOM_FIELD_ENTITIES.map((x) => <option key={x} value={x}>{t(`crmSettings.cfEntity.${x}` as MessageKey)}</option>)}
              </Select>
            </Field>
            <Field label={t('crmSettings.cfType')} htmlFor="cf-type">
              <Select id="cf-type" value={cfType} onChange={(e) => setCfType(e.target.value)}>
                {CUSTOM_FIELD_TYPES.map((x) => <option key={x} value={x}>{t(`crmSettings.cfType.${x}` as MessageKey)}</option>)}
              </Select>
            </Field>
            {cfType === 'select' && (
              <div className="sm:col-span-2">
                <Field label={t('crmSettings.cfOptions')} htmlFor="cf-options" error={cfErrors.options && t('form.required')}>
                  <Input id="cf-options" name="options" />
                </Field>
              </div>
            )}
            {!!s.tracks.length && (
              <Field label={t('accounts.track')} htmlFor="cf-track" optional>
                <Select id="cf-track" name="trackId" defaultValue="">
                  <option value="">{t('crmSettings.allTracks')}</option>
                  {s.tracks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
                </Select>
              </Field>
            )}
            <div className="flex items-end justify-end sm:col-span-2">
              <Button type="submit" loading={createField.isPending}>{t('common.add')}</Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
