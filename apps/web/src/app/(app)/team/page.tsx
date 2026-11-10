'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ASSIGNABLE_ROLES, canAssignRole, inviteSchema, type InvitationDto, type MemberDto, type SystemRole,
} from '@rakan/shared';
import { useState, type FormEvent } from 'react';
import {
  Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, NoPermission, PageHeader, Select,
  formatDate,
} from '@/components/ui';
import { useConfirm, useToast } from '@/components/feedback';
import { api } from '@/lib/api';
import { formObject, validate, type FieldErrors } from '@/lib/forms';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n, useInvalidate, useMe } from '@/lib/providers';

export default function TeamPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const { t, err, locale } = useI18n();
  const can = useCan();
  const me = useMe();
  const invalidate = useInvalidate();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  const members = useQuery({ queryKey: ['members'], queryFn: () => api<MemberDto[]>('/team/members'), enabled: can('team.member.read') });
  const invites = useQuery({ queryKey: ['invitations'], queryFn: () => api<InvitationDto[]>('/team/invitations'), enabled: can('team.member.read') });

  const invite = useMutation({
    mutationFn: (body: object) => api<InvitationDto>('/team/invitations', { method: 'POST', body }),
    onSuccess: (inv) => {
      setInviteOpen(false);
      toast(t('toast.inviteSent'));
      setNotice(t('team.inviteSent', { email: inv.email }));
      invalidate('invitations');
      invalidate('audit');
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/team/invitations/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate('invitations'),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) => api<MemberDto>(`/team/members/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      toast(t('common.saveSuccess'));
      invalidate('members');
    },
  });

  if (!me.data) return null;
  if (!can('team.member.read')) return <NoPermission />;
  const myRole = me.data.activeTenant!.role;
  const roleLabel = (r: SystemRole) => t(`role.${r}` as MessageKey);
  const assignable = ASSIGNABLE_ROLES[myRole];

  function submitInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = formObject(e.currentTarget);
    if (!data.title?.trim()) delete data.title;
    const v = validate(inviteSchema, data);
    setErrors(v.ok ? {} : v.errors);
    if (v.ok) invite.mutate(v.data);
  }

  return (
    <>
      <PageHeader
        title={t('team.title')}
        actions={
          can('team.member.invite') && (
            <Button icon="plus" onClick={() => { invite.reset(); setErrors({}); setInviteOpen(true); }}>{t('team.invite')}</Button>
          )
        }
      />
      <div className="space-y-6">
        {notice && <Alert tone="success">{notice}</Alert>}
        {update.error && <Alert tone="error">{err(update.error)}</Alert>}

        <Card>
          <h2 className="border-b border-line-soft px-5 py-3 font-medium">{t('team.members')}</h2>
          {members.isLoading ? (
            <LoadingState />
          ) : members.error ? (
            <div className="p-4"><ErrorState error={members.error} onRetry={() => members.refetch()} /></div>
          ) : (
            <ul className="stagger divide-y divide-line-soft">
              {members.data!.map((m) => {
                const isSelf = m.userId === me.data!.user.id;
                const manageable = can('team.member.update') && !isSelf && canAssignRole(myRole, m.role);
                return (
                  <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {m.fullName} {isSelf && <span className="text-sm font-normal text-fg-muted">{t('team.you')}</span>}
                      </p>
                      <p className="truncate text-sm text-fg-muted"><bdi>{m.email}</bdi></p>
                      {m.title && <p className="text-sm text-fg-muted">{m.title}</p>}
                    </div>
                    {m.status === 'disabled' && <Badge tone="muted">{t('status.disabled')}</Badge>}
                    {manageable ? (
                      <>
                        <label className="sr-only" htmlFor={`role-${m.id}`}>{t('team.role')}</label>
                        <Select
                          id={`role-${m.id}`}
                          className="w-40"
                          value={m.role}
                          disabled={update.isPending}
                          onChange={(e) => update.mutate({ id: m.id, body: { role: e.target.value } })}
                        >
                          {assignable.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                        </Select>
                        <Button
                          variant={m.status === 'active' ? 'danger' : 'secondary'}
                          disabled={update.isPending}
                          onClick={async () => {
                            if (m.status === 'active' && !(await confirm({ title: t('team.confirmDisable', { name: m.fullName }), tone: 'danger', confirmLabel: t('team.disable') }))) return;
                            update.mutate({ id: m.id, body: { status: m.status === 'active' ? 'disabled' : 'active' } });
                          }}
                        >
                          {m.status === 'active' ? t('team.disable') : t('team.enable')}
                        </Button>
                      </>
                    ) : (
                      <Badge tone={m.role === 'owner' ? 'brand' : 'neutral'}>{roleLabel(m.role)}</Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="border-b border-line-soft px-5 py-3 font-medium">{t('team.pending')}</h2>
          {invites.isLoading ? (
            <LoadingState />
          ) : invites.error ? (
            <div className="p-4"><ErrorState error={invites.error} onRetry={() => invites.refetch()} /></div>
          ) : invites.data!.length === 0 ? (
            <EmptyState icon="inbox">{t('team.noPending')}</EmptyState>
          ) : (
            <ul className="stagger divide-y divide-line-soft">
              {invites.data!.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium"><bdi>{i.email}</bdi></p>
                    <p className="text-sm text-fg-muted">
                      {roleLabel(i.role)} · {t('team.expires', { date: formatDate(i.expiresAt, locale) })}
                    </p>
                  </div>
                  {can('team.member.invite') && canAssignRole(myRole, i.role) && (
                    <Button variant="ghost" loading={revoke.isPending && revoke.variables === i.id} onClick={() => revoke.mutate(i.id)}>
                      {t('team.revoke')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title={t('team.inviteTitle')}>
        <form onSubmit={submitInvite} noValidate className="space-y-4">
          {invite.error && <Alert tone="error">{err(invite.error)}</Alert>}
          <Field label={t('common.email')} htmlFor="invite-email" error={errors.email && t(errors.email.key)}>
            <Input id="invite-email" name="email" type="email" dir="ltr" autoFocus aria-invalid={!!errors.email} />
          </Field>
          <Field label={t('team.role')} htmlFor="invite-role">
            <Select id="invite-role" name="role" defaultValue="rep">
              {assignable.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </Select>
          </Field>
          <Field label={t('team.jobTitle')} htmlFor="invite-title" optional>
            <Input id="invite-title" name="title" />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setInviteOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" loading={invite.isPending}>{t('team.invite')}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
