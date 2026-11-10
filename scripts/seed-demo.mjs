/**
 * Development only: fills a demo company through the public API so the UI can be reviewed with content.
 * All names are fictional. Usage: node scripts/seed-demo.mjs [apiBase]
 */
const API = (process.argv[2] ?? 'http://localhost:4000') + '/api';
const PASSWORD = 'demo-password-2026';

function client() {
  const jar = new Map();
  const store = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (method, path, body) => {
    if (!jar.has('rakan_csrf')) store(await fetch(`${API}/auth/csrf`));
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookie(), 'x-csrf-token': decodeURIComponent(jar.get('rakan_csrf') ?? '') },
      body: body ? JSON.stringify(body) : undefined,
    });
    store(res);
    const data = res.status === 204 ? null : await res.json();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const at = (days, hour = 10) => {
  const d = new Date(Date.now() + days * 86400_000);
  const r = new Date(d.getTime() + 3 * 3600_000);
  return new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate(), hour - 3)).toISOString();
};

const owner = client();
await owner.post('/auth/register', { fullName: 'هند العتيبي', email: 'demo@rakan.local', password: PASSWORD, companyName: 'شركة العرض التجريبية' });
await owner.post('/team/invitations', { email: 'rep@rakan.local', role: 'rep' });
console.log('owner: demo@rakan.local /', PASSWORD);

const s1 = await owner.post('/crm/tracks', { key: 'shippers', name: 'طالبو النقل' });
const s2 = await owner.post('/crm/tracks', { key: 'carriers', name: 'شركات النقل' });
const [shippers] = s1.tracks;
const carriers = s2.tracks.find((t) => t.key === 'carriers');
const settings = await owner.get('/crm/settings');
const stageIn = (trackId, key) => settings.pipelines.find((p) => p.trackId === trackId)?.stages.find((s) => s.key === key)?.id;
const reason = (kind) => settings.reasons.find((r) => r.kind === kind).id;
const me = await owner.get('/auth/me');
const ownerMid = me.activeTenant.membershipId;

const accounts = [
  { name: 'مصنع الواحة للأغذية', city: 'الرياض', region: 'الرياض', industry: 'صناعة الأغذية', trackId: shippers.id, amount: 180000, stage: 'negotiation' },
  { name: 'مستودعات الشمال', city: 'حائل', region: 'حائل', industry: 'تخزين', trackId: shippers.id, amount: 95000, stage: 'proposal_sent' },
  { name: 'مؤسسة البناء المتقدم', city: 'جدة', region: 'مكة المكرمة', industry: 'مقاولات', trackId: shippers.id, amount: 240000, stage: 'visit_done' },
  { name: 'شركة الخليج للاستيراد', city: 'الدمام', region: 'المنطقة الشرقية', industry: 'استيراد', trackId: shippers.id, amount: 60000, stage: 'qualified' },
  { name: 'موزعو الجنوب', city: 'أبها', region: 'عسير', industry: 'توزيع', trackId: shippers.id, amount: 45000, stage: 'new' },
  { name: 'ناقلات الصحراء', city: 'الرياض', region: 'الرياض', industry: 'نقل ثقيل', trackId: carriers.id, amount: 30000, stage: 'contacted' },
  { name: 'أسطول التبريد الحديث', city: 'جدة', region: 'مكة المكرمة', industry: 'نقل مبرد', trackId: carriers.id, amount: 52000, stage: 'won' },
  { name: 'شركة المعدات الثقيلة', city: 'الجبيل', region: 'المنطقة الشرقية', industry: 'نقل معدات', trackId: carriers.id, amount: 70000, stage: 'lost' },
];
const created = [];
for (const a of accounts) {
  const acc = await owner.post('/crm/accounts', { name: a.name, city: a.city, region: a.region, industry: a.industry, trackId: a.trackId, ownerMembershipId: ownerMid });
  await owner.post(`/crm/accounts/${acc.id}/contacts`, { fullName: 'مسؤول المشتريات', jobTitle: 'مدير المشتريات', phone: '0500000000', isPrimary: true });
  const opp = await owner.post('/crm/opportunities', { accountId: acc.id, title: a.trackId === shippers.id ? 'عقد نقل سنوي' : 'الانضمام للمنصة', amount: a.amount });
  if (a.stage !== 'new') {
    const body = { stageId: stageIn(a.trackId, a.stage) };
    if (a.stage === 'won') body.outcomeReasonId = reason('win');
    if (a.stage === 'lost') body.outcomeReasonId = reason('loss');
    await owner.post(`/crm/opportunities/${opp.id}/stage`, body);
  }
  created.push({ acc, opp, ...a });
}

// Visits: today, later this week, and one completed
const v1 = await owner.post('/crm/visits', { accountId: created[0].acc.id, opportunityId: created[0].opp.id, scheduledStart: at(0, 11), purpose: 'مناقشة شروط العقد' });
await owner.post('/crm/visits', { accountId: created[3].acc.id, opportunityId: created[3].opp.id, scheduledStart: at(0, 14), purpose: 'تعريف بخدمات المنصة' });
await owner.post('/crm/visits', { accountId: created[4].acc.id, scheduledStart: at(2, 10), purpose: 'زيارة أولى' });
await owner.post('/crm/visits', { accountId: created[5].acc.id, scheduledStart: at(3, 12), purpose: 'شرح طريقة الانضمام' });
const done = await owner.post('/crm/visits', { accountId: created[2].acc.id, scheduledStart: at(-1, 10), purpose: 'عرض الخدمة' });
await owner.post(`/crm/visits/${done.id}/check-in`, {});
await owner.post(`/crm/visits/${done.id}/complete`, { outcome: 'interested', interestLevel: 4, nextStep: 'send_proposal', nextFollowUpAt: at(2, 9), notes: 'العميل مهتم بالنقل المنتظم بين جدة والرياض.' });
void v1;

// Tasks: overdue, today, upcoming
await owner.post('/crm/tasks', { title: 'إرسال عرض السعر المحدّث', type: 'send_proposal', priority: 'high', dueAt: at(-1, 9), accountId: created[1].acc.id });
await owner.post('/crm/tasks', { title: 'اتصال متابعة مع مدير المشتريات', type: 'call', dueAt: at(0, 16), accountId: created[3].acc.id });
await owner.post('/crm/tasks', { title: 'تجهيز ملف التعاقد', type: 'todo', dueAt: at(4, 10), accountId: created[0].acc.id });
await owner.post(`/crm/accounts/${created[0].acc.id}/notes`, { body: 'يفضّلون التواصل صباحاً. القرار عند المدير المالي.' });

console.log(`seeded ${created.length} accounts, 5 visits, 4 tasks`);
