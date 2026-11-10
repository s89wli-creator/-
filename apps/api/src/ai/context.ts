import { accounts, contacts, notes, opportunities, pipelineStages, tracks, visits, type Tx } from '@rakan/db';
import type { Evidence } from '@rakan/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BrainEntry } from './brain.service';
import { redactPii, untrusted } from './guards';

type AccountRow = typeof accounts.$inferSelect;

/**
 * Builds the model input for one account and the set of references the model may cite.
 * Every reference the model returns is checked against `refs`; anything else is dropped.
 */
export interface Grounding {
  text: string;
  refs: Map<string, string>; // ref -> human label
}

const ACCOUNT_FIELDS: { key: keyof AccountRow; label: string }[] = [
  { key: 'name', label: 'اسم العميل' },
  { key: 'industry', label: 'القطاع' },
  { key: 'sizeBand', label: 'الحجم' },
  { key: 'region', label: 'المنطقة' },
  { key: 'city', label: 'المدينة' },
  { key: 'websiteDomain', label: 'الموقع الإلكتروني' },
  { key: 'crNumber', label: 'السجل التجاري' },
  { key: 'leadSource', label: 'مصدر العميل' },
  { key: 'status', label: 'الحالة' },
];

export async function accountGrounding(tx: Tx, tenantId: string, a: AccountRow): Promise<Grounding> {
  const refs = new Map<string, string>();
  const lines: string[] = [];
  for (const f of ACCOUNT_FIELDS) {
    const v = a[f.key];
    if (v === null || v === undefined || v === '') continue;
    const ref = `account:${String(f.key)}`;
    refs.set(ref, f.label);
    lines.push(`- [${ref}] ${f.label}: ${String(v)}`);
  }
  if (a.trackId) {
    const [t] = await tx.select({ name: tracks.name }).from(tracks).where(and(eq(tracks.tenantId, tenantId), eq(tracks.id, a.trackId)));
    if (t) {
      refs.set('account:track', 'المسار');
      lines.push(`- [account:track] المسار: ${t.name}`);
    }
  }
  const cf = Object.entries(a.customFields ?? {}).filter(([, v]) => v !== null && v !== '');
  for (const [k, v] of cf.slice(0, 15)) {
    const ref = `account:custom.${k}`;
    refs.set(ref, k);
    lines.push(`- [${ref}] ${k}: ${redactPii(String(v)).slice(0, 200)}`);
  }

  const cs = await tx
    .select({ id: contacts.id, jobTitle: contacts.jobTitle, dnc: contacts.doNotContact })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.accountId, a.id), isNull(contacts.deletedAt)))
    .limit(10);
  if (cs.length) {
    refs.set('account:contacts', 'جهات الاتصال');
    lines.push(`- [account:contacts] جهات الاتصال المسجلة: ${cs.length} (المسميات: ${cs.map((c) => c.jobTitle ?? 'غير محدد').join('، ')})`);
  }

  const opps = await tx
    .select({ id: opportunities.id, title: opportunities.title, amount: opportunities.amount, stage: pipelineStages.name })
    .from(opportunities)
    .leftJoin(pipelineStages, and(eq(pipelineStages.tenantId, opportunities.tenantId), eq(pipelineStages.id, opportunities.stageId)))
    .where(and(eq(opportunities.tenantId, tenantId), eq(opportunities.accountId, a.id)))
    .orderBy(desc(opportunities.createdAt))
    .limit(5);
  for (const o of opps) {
    const ref = `opportunity:${o.id}`;
    refs.set(ref, `فرصة: ${o.title}`);
    lines.push(`- [${ref}] فرصة "${o.title}" في مرحلة ${o.stage ?? '—'}${o.amount ? ` بقيمة ${o.amount} ر.س` : ''}`);
  }

  const ns = await tx
    .select({ id: notes.id, body: notes.body, at: notes.createdAt })
    .from(notes)
    .where(and(eq(notes.tenantId, tenantId), eq(notes.accountId, a.id), isNull(notes.deletedAt)))
    .orderBy(desc(notes.createdAt))
    .limit(5);
  const vs = await tx
    .select({ id: visits.id, at: visits.scheduledStart, outcome: visits.outcome, notes: visits.notes, interest: visits.interestLevel, status: visits.status })
    .from(visits)
    .where(and(eq(visits.tenantId, tenantId), eq(visits.accountId, a.id)))
    .orderBy(desc(visits.scheduledStart))
    .limit(5);

  const history: string[] = [];
  for (const n of ns) {
    refs.set(`note:${n.id}`, `ملاحظة ${n.at.toISOString().slice(0, 10)}`);
    history.push(`[note:${n.id}] (${n.at.toISOString().slice(0, 10)}) ${redactPii(n.body).slice(0, 800)}`);
  }
  for (const v of vs.filter((x) => x.status === 'completed')) {
    refs.set(`visit:${v.id}`, `زيارة ${v.at.toISOString().slice(0, 10)}`);
    history.push(`[visit:${v.id}] (${v.at.toISOString().slice(0, 10)}) النتيجة: ${v.outcome ?? '—'}، الاهتمام: ${v.interest ?? '—'}/5. ${redactPii(v.notes ?? '').slice(0, 800)}`);
  }

  const text = [
    '## بيانات العميل (من نظام CRM)',
    ...lines,
    history.length ? `\n## ملاحظات وزيارات سابقة (نصوص كتبها الفريق)\n${untrusted('crm_notes', history.join('\n'))}` : '\n## ملاحظات وزيارات سابقة: غير متوفر',
  ].join('\n');
  return { text, refs };
}

export function brainGrounding(entries: BrainEntry[]): Grounding {
  const refs = new Map<string, string>();
  if (!entries.length) return { text: '## معرفة الشركة المعتمدة: غير متوفر (لم تعتمد الشركة أي معرفة بعد)', refs };
  const lines = entries.map((e) => {
    refs.set(e.id, e.title);
    // Approved documents are company-provided but still external text: keep them wrapped as data.
    const body = e.section === 'document' ? untrusted('company_document', e.text.slice(0, 1500)) : e.text.slice(0, 1500);
    return `### [${e.id}] (${e.section}) ${e.title}\n${body}`;
  });
  return { text: `## معرفة الشركة المعتمدة (Sales Brain)\n${lines.join('\n\n')}`, refs };
}

export function merge(...g: Grounding[]): Grounding {
  return { text: g.map((x) => x.text).join('\n\n'), refs: new Map(g.flatMap((x) => [...x.refs])) };
}

export const toEvidence = (refs: Map<string, string>, ids: string[]): Evidence[] =>
  [...new Set(ids)].filter((r) => refs.has(r)).map((ref) => ({ ref, label: refs.get(ref)! }));
