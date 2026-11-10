'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SecurityDto } from '@rakan/shared';
import { useState, type FormEvent } from 'react';
import { useConfirm, useToast } from '@/components/feedback';
import { Icon } from '@/components/icons';
import { Alert, Badge, Button, Card, ErrorState, Field, Input, LoadingState, Modal, PageHeader, CardHeading, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/providers';

/** Short, readable device label from a user-agent string (no third-party parser). */
function deviceLabel(ua: string | null): string | null {
  if (!ua) return null;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null;
  return [br, os].filter(Boolean).join(' · ') || null;
}

function codeOf(e: FormEvent<HTMLFormElement>): string {
  return String(new FormData(e.currentTarget).get('code') ?? '').trim();
}

export default function SecurityPage() {
  const { t, err, locale } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const sec = useQuery({ queryKey: ['security'], queryFn: () => api<SecurityDto>('/auth/security') });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['security'] }), qc.invalidateQueries({ queryKey: ['me'] })]);

  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const setup = useMutation({ mutationFn: () => api<{ qr: string; secret: string }>('/auth/mfa/setup', { method: 'POST' }) });
  const enable = useMutation({
    mutationFn: (code: string) => api<{ recoveryCodes: string[] }>('/auth/mfa/enable', { method: 'POST', body: { code } }),
    onSuccess: async (r) => {
      setSetupOpen(false);
      setRecovery(r.recoveryCodes);
      toast(t('security.mfa.enabled'));
      await refresh();
    },
  });
  const disable = useMutation({
    mutationFn: (code: string) => api('/auth/mfa/disable', { method: 'POST', body: { code } }),
    onSuccess: async () => {
      setDisableOpen(false);
      toast(t('security.mfa.disabled'));
      await refresh();
    },
  });
  const resend = useMutation({
    mutationFn: () => api('/auth/email/resend', { method: 'POST' }),
    onSuccess: () => toast(t('security.email.sent')),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast(t('security.sessions.revoked'));
      await refresh();
    },
  });

  if (sec.isLoading) return <LoadingState card />;
  if (sec.error) return <ErrorState error={sec.error} onRetry={() => sec.refetch()} />;
  const d = sec.data!;

  return (
    <>
      <PageHeader title={t('security.title')} subtitle={t('security.subtitle')} />
      <div className="space-y-5">
        <Card className="p-5 sm:p-6">
          <CardHeading action={<Badge tone={d.mfaEnabled ? 'success' : 'neutral'} dot>{t(d.mfaEnabled ? 'security.mfa.on' : 'security.mfa.off')}</Badge>}>
            {t('security.mfa.title')}
          </CardHeading>
          <p className="mb-4 text-fg-sub">{t('security.mfa.desc')}</p>
          {d.mfaEnabled ? (
            <Button variant="secondary" onClick={() => { disable.reset(); setDisableOpen(true); }}>{t('security.mfa.disable')}</Button>
          ) : (
            <Button icon="lock" onClick={() => { enable.reset(); setSetupOpen(true); setup.mutate(); }}>{t('security.mfa.start')}</Button>
          )}
        </Card>

        <Card className="p-5 sm:p-6">
          <CardHeading action={<Badge tone={d.emailVerified ? 'success' : 'warn'} dot>{t(d.emailVerified ? 'security.email.verified' : 'security.email.unverified')}</Badge>}>
            {t('security.email.title')}
          </CardHeading>
          {!d.emailVerified && (
            <div className="space-y-3">
              <p className="text-fg-sub">{t('security.email.banner')}</p>
              {resend.error && <Alert tone="error">{err(resend.error)}</Alert>}
              <Button variant="secondary" loading={resend.isPending} disabled={resend.isSuccess} onClick={() => resend.mutate()}>
                {t('security.email.resend')}
              </Button>
            </div>
          )}
        </Card>

        <Card className="p-5 sm:p-6">
          <CardHeading>{t('security.sessions.title')}</CardHeading>
          {revoke.error && <Alert tone="error">{err(revoke.error)}</Alert>}
          <ul className="divide-y divide-line-soft">
            {d.sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-subtle-strong text-fg-sub" aria-hidden><Icon name="monitor" size={20} /></span>
                  <div className="min-w-0">
                    <p className="font-medium">
                      {deviceLabel(s.userAgent) ?? t('security.sessions.unknownDevice')}{' '}
                      {s.current && <Badge tone="brand">{t('security.sessions.current')}</Badge>}
                    </p>
                    <p className="text-sm text-fg-muted">
                      {t('security.sessions.lastSeen')}: {formatDate(s.lastSeenAt, locale, true)}
                      {s.ip && <> · <bdi dir="ltr">{s.ip}</bdi></>}
                    </p>
                  </div>
                </div>
                {!s.current && (
                  <Button
                    variant="ghost"
                    loading={revoke.isPending && revoke.variables === s.id}
                    onClick={async () => {
                      if (await confirm({ title: t('security.sessions.revoke'), body: t('security.sessions.revokeConfirm'), confirmLabel: t('security.sessions.revoke') })) revoke.mutate(s.id);
                    }}
                  >
                    {t('security.sessions.revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Modal open={setupOpen} onClose={() => setSetupOpen(false)} title={t('security.mfa.start')}>
        {setup.error && <Alert tone="error">{err(setup.error)}</Alert>}
        {setup.isPending && <LoadingState rows={3} />}
        {setup.data && (
          <form noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); const c = codeOf(e); if (c) enable.mutate(c); }}>
            <p className="text-fg-sub">{t('security.mfa.scan')}</p>
            {/* The QR is generated by our server (data URL); no third-party image service sees the secret. */}
            <img src={setup.data.qr} alt="" width={220} height={220} className="mx-auto rounded-lg bg-white p-2" />
            <div className="rounded-lg bg-subtle p-3 text-sm">
              <p className="text-fg-muted">{t('security.mfa.manual')}</p>
              <p className="mt-1 break-all font-mono" dir="ltr">{setup.data.secret}</p>
            </div>
            {enable.error && <Alert tone="error">{err(enable.error)}</Alert>}
            <Field label={t('security.mfa.code')} htmlFor="mfa-code">
              <Input id="mfa-code" name="code" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} required className="text-center text-lg" />
            </Field>
            <Button type="submit" className="w-full" loading={enable.isPending}>{t('security.mfa.confirm')}</Button>
          </form>
        )}
      </Modal>

      <Modal open={!!recovery} onClose={() => setRecovery(null)} title={t('security.mfa.recoveryTitle')}>
        <Alert tone="warn">{t('security.mfa.recoveryHint')}</Alert>
        <ul className="my-4 grid grid-cols-2 gap-2 font-mono text-sm" dir="ltr">
          {recovery?.map((c) => <li key={c} className="rounded-md bg-subtle px-3 py-2 text-center">{c}</li>)}
        </ul>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard?.writeText(recovery?.join('\n') ?? '');
              toast(t('security.mfa.copied'));
            }}
          >
            {t('security.mfa.copy')}
          </Button>
          <Button onClick={() => setRecovery(null)}>{t('security.mfa.recoverySaved')}</Button>
        </div>
      </Modal>

      <Modal open={disableOpen} onClose={() => setDisableOpen(false)} title={t('security.mfa.disable')}>
        <form noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); const c = codeOf(e); if (c) disable.mutate(c); }}>
          <p className="text-fg-sub">{t('security.mfa.disableHint')}</p>
          {disable.error && <Alert tone="error">{err(disable.error)}</Alert>}
          <Field label={t('security.mfa.code')} htmlFor="mfa-off-code">
            <Input id="mfa-off-code" name="code" dir="ltr" maxLength={20} required className="text-center text-lg" />
          </Field>
          <Button type="submit" variant="danger-solid" className="w-full" loading={disable.isPending}>{t('security.mfa.disable')}</Button>
        </form>
      </Modal>
    </>
  );
}
