'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssistantConversationDto } from '@rakan/shared';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AiNotice, useAiStatus } from '@/components/ai/panels';
import { Symbol } from '@/components/brand/Logo';
import { Icon } from '@/components/icons';
import { Alert, Button, Card, NoPermission, Textarea, cx, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n } from '@/lib/providers';

const SUGGESTIONS: MessageKey[] = ['assistant.s.attention', 'assistant.s.tomorrow', 'assistant.s.overdue', 'assistant.s.prospects'];

/** "Ask Rakan": chat that answers from the company's own data through permission-checked tools. */
export default function AssistantPage() {
  const { t, err, locale } = useI18n();
  const can = useCan();
  const qc = useQueryClient();
  const status = useAiStatus();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingText, setPendingText] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const list = useQuery({ queryKey: ['assistant-convs'], queryFn: () => api<AssistantConversationDto[]>('/ai/assistant/conversations'), enabled: can('ai.use') });
  const conv = useQuery({
    queryKey: ['assistant-conv', conversationId],
    queryFn: () => api<AssistantConversationDto>(`/ai/assistant/conversations/${conversationId}`),
    enabled: !!conversationId,
  });
  const send = useMutation({
    mutationFn: (message: string) => api<AssistantConversationDto>('/ai/assistant/messages', { method: 'POST', body: { conversationId: conversationId ?? undefined, message } }),
    onMutate: (m) => setPendingText(m),
    onSuccess: (c) => {
      qc.setQueryData(['assistant-conv', c.id], c);
      setConversationId(c.id);
      setDraft('');
      void qc.invalidateQueries({ queryKey: ['assistant-convs'] });
      void qc.invalidateQueries({ queryKey: ['ai-status'] });
    },
    onSettled: () => setPendingText(null),
  });
  const messages = conv.data?.messages ?? [];
  useEffect(() => endRef.current?.scrollIntoView({ block: 'end', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }), [messages.length, pendingText]);

  if (!can('ai.use')) return <NoPermission />;
  const disabled = !status.data?.available;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const m = draft.trim();
    if (m && !send.isPending) send.mutate(m);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <Card className="hidden h-fit p-3 lg:block">
        <Button variant="secondary" icon="plus" className="mb-2 w-full" onClick={() => { setConversationId(null); send.reset(); }}>{t('assistant.new')}</Button>
        <nav aria-label={t('assistant.history')} className="space-y-0.5">
          {list.data?.map((c) => (
            <button key={c.id} onClick={() => setConversationId(c.id)} aria-current={c.id === conversationId ? 'true' : undefined}
              className={cx('block w-full rounded-lg px-3 py-2 text-start text-sm transition-colors', c.id === conversationId ? 'bg-brand-50 font-medium text-brand-700' : 'text-fg-sub hover:bg-subtle-strong')}>
              <span className="line-clamp-1">{c.title}</span>
              <span className="text-xs text-fg-muted">{formatDate(c.updatedAt, locale)}</span>
            </button>
          ))}
        </nav>
      </Card>

      <Card className="flex min-h-[60dvh] flex-col lg:min-h-[calc(100dvh-12rem)]">
        <div className="flex items-center gap-3 border-b border-line-soft px-5 py-3">
          <Symbol size={28} />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">{t('assistant.title')}</h1>
            <p className="truncate text-xs text-fg-muted">{t('assistant.subtitle')}</p>
          </div>
          {conversationId && <Button variant="ghost" className="min-h-9 lg:hidden" onClick={() => setConversationId(null)}>{t('assistant.new')}</Button>}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6" aria-live="polite">
          <AiNotice status={status.data} />
          {!messages.length && !pendingText && (
            <div className="mx-auto max-w-lg space-y-4 py-6 text-center">
              <p className="text-fg-sub">{t('assistant.intro')}</p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((k) => (
                  <button key={k} disabled={disabled || send.isPending} onClick={() => send.mutate(t(k))}
                    className="min-h-10 rounded-full border border-line bg-surface px-4 text-sm text-fg-sub transition-colors hover:border-brand-600 hover:text-brand-700 disabled:opacity-50">
                    {t(k)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={cx('flex', m.role === 'user' ? 'justify-start' : 'justify-end')}>
              <div className={cx('max-w-[85%] space-y-2 rounded-2xl px-4 py-3', m.role === 'user' ? 'bg-brand-600 text-on-brand' : 'border border-line bg-subtle text-fg')}>
                <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                {m.toolCalls.length > 0 && (
                  <details className="text-xs text-fg-muted">
                    <summary className="cursor-pointer">{t('assistant.usedTools', { n: m.toolCalls.length })}</summary>
                    <ul className="mt-1 space-y-0.5">
                      {m.toolCalls.map((c, i) => <li key={i}>{c.ok ? '✓' : '✕'} {t(`assistant.tool.${c.tool}` as MessageKey)}</li>)}
                    </ul>
                  </details>
                )}
                {m.links.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {m.links.map((l) => (
                      <Link key={l.href} href={l.href} className="inline-flex min-h-8 items-center gap-1 rounded-full bg-surface px-3 text-xs font-medium text-brand-700 shadow-xs hover:underline">
                        {l.label} <Icon name="chevronEnd" size={16} />
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {pendingText && (
            <>
              <div className="flex justify-start"><div className="max-w-[85%] rounded-2xl bg-brand-600 px-4 py-3 text-on-brand">{pendingText}</div></div>
              <div className="flex justify-end" role="status">
                <div className="flex items-center gap-2 rounded-2xl border border-line bg-subtle px-4 py-3 text-sm text-fg-muted">
                  <span className="flex gap-1" aria-hidden>
                    {[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-pulse rounded-full bg-fg-muted motion-reduce:animate-none" style={{ animationDelay: `${i * 150}ms` }} />)}
                  </span>
                  {t('assistant.thinking')}
                </div>
              </div>
            </>
          )}
          {send.error && <Alert tone="error">{err(send.error)}</Alert>}
          <div ref={endRef} />
        </div>

        <form onSubmit={submit} className="flex items-end gap-2 border-t border-line-soft p-3 sm:p-4">
          <label htmlFor="assistant-input" className="sr-only">{t('assistant.placeholder')}</label>
          <Textarea
            id="assistant-input" rows={1} value={draft} maxLength={2000} disabled={disabled} placeholder={t('assistant.placeholder')}
            className="max-h-40 min-h-11 flex-1 resize-none"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          />
          <Button type="submit" icon="sparkle" loading={send.isPending} disabled={disabled || !draft.trim()} aria-label={t('assistant.send')}>
            <span className="hidden sm:inline">{t('assistant.send')}</span>
          </Button>
        </form>
        <p className="px-4 pb-3 text-center text-xs text-fg-muted">{t('assistant.footer')}</p>
      </Card>
    </div>
  );
}
