import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sameUrl } from '../src/ai/prospecting.service';
import { fake, installDefaultAgents } from './ai-fake';
import { addMember, outbox, ownerQuery, registerCompany, resetDb, startApp, type TestClient } from './helpers';

let app: INestApplication;
let owner: TestClient;
let tenantId: string;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  outbox(app).length = 0;
  fake(app).reset();
  installDefaultAgents(fake(app));
  ({ client: owner, tenantId } = await registerCompany(app, { email: 'o@agents.sa', company: 'شركة الوكلاء' }));
});

const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();

describe('needs attention (rules, no AI)', () => {
  it('finds silent deals, overdue tasks, loose visits and untouched A/B leads — reps see their own', async () => {
    const { client: rep, membershipId } = await addMember(app, owner, 'rep@agents.sa', 'rep');
    const silent = (await owner.post('/crm/accounts', { name: 'عميل صامت', ownerMembershipId: membershipId }).expect(201)).body;
    await owner.post('/crm/opportunities', { accountId: silent.id, title: 'صفقة نقل', amount: 50000 }).expect(201);
    const hot = (await owner.post('/crm/accounts', { name: 'عميل واعد' }).expect(201)).body;
    await owner.post('/crm/tasks', { title: 'اتصال متأخر', accountId: hot.id, dueAt: daysAgo(2) }).expect(201);
    await ownerQuery(`UPDATE accounts SET last_activity_at = $2 WHERE id = $1`, [silent.id, daysAgo(20)]);
    await ownerQuery(`UPDATE accounts SET last_activity_at = $2, score_tier = 'A', score = 80 WHERE id = $1`, [hot.id, daysAgo(30)]);

    const all = (await owner.get('/crm/attention').expect(200)).body as { type: string; accountName: string; days: number }[];
    expect(all.map((x) => x.type).sort()).toEqual(['hot_lead_untouched', 'overdue_task', 'stale_deal']);
    expect(all[0]).toMatchObject({ type: 'hot_lead_untouched', accountName: 'عميل واعد' });
    expect(all.find((x) => x.type === 'stale_deal')!.days).toBeGreaterThanOrEqual(19);

    const mine = (await rep.get('/crm/attention').expect(200)).body as { accountName: string }[];
    expect(mine.map((x) => x.accountName)).toEqual(['عميل صامت']);
  });
});

describe('prospecting agent', () => {
  it('keeps only candidates that cite a page the search really returned; flags duplicates; bills searches', async () => {
    const icp = (await owner.post('/brain/items', { section: 'icp', title: 'مصانع الأغذية', body: 'نستهدف مصانع الأغذية التي تحتاج نقلاً مبرداً' }).expect(201)).body;
    await owner.post(`/brain/items/${icp.id}/approve`).expect(200);
    await owner.post('/crm/accounts', { name: 'مصنع البركة للأغذية', city: 'الرياض' }).expect(201);
    fake(app).on('prospecting', (req) => {
      expect(req.webSearch).toMatchObject({ maxUses: 5, country: 'SA', city: 'الرياض' });
      return {
        __sources: [
          { url: 'https://dir.example.sa/companies/nour-foods', title: 'مصنع النور للأغذية' },
          { url: 'https://news.example.sa/baraka', title: 'البركة' },
        ],
        candidates: [
          { name: 'مصنع النور للأغذية', website: 'https://www.nourfoods.sa', city: 'الرياض', region: null, industry: 'أغذية', phone: '0112345678',
            whyFit: 'مصنع أغذية يحتاج نقلاً مبرداً', fitEvidence: [{ text: 'قطاع مستهدف', ref: `brain:${icp.id}` }], sourceUrl: 'https://dir.example.sa/companies/nour-foods/', confidence: 0.8 },
          { name: 'شركة مخترعة', website: null, city: 'الرياض', region: null, industry: null, phone: null,
            whyFit: 'تخمين', fitEvidence: [], sourceUrl: 'https://invented.example/x', confidence: 0.9 },
          { name: 'مصنع البركة للأغذية', website: null, city: 'الرياض', region: null, industry: 'أغذية', phone: null,
            whyFit: 'مناسب', fitEvidence: [{ text: 'x', ref: 'brain:not-real' }], sourceUrl: 'https://news.example.sa/baraka', confidence: 0.9 },
        ],
      };
    });
    const s = (await owner.post('/ai/prospecting/search', { query: 'مصانع أغذية تحتاج نقل مبرد', city: 'الرياض' }).expect(201)).body;
    expect(s).toMatchObject({ source: 'web_search', status: 'done', found: 2, dropped: [{ name: 'شركة مخترعة', reason: 'source_not_in_results' }] });

    const list = (await owner.get('/ai/prospecting/prospects?status=pending_review').expect(200)).body as Record<string, unknown>[];
    const nour = list.find((p) => p.name === 'مصنع النور للأغذية')!;
    expect(nour).toMatchObject({ sourceUrl: 'https://dir.example.sa/companies/nour-foods', websiteDomain: 'nourfoods.sa', duplicateOf: null, confidence: 0.8 });
    expect((nour.fitEvidence as { label: string }[])[0]!.label).toBe('مصانع الأغذية');
    const baraka = list.find((p) => p.name === 'مصنع البركة للأغذية')!;
    expect((baraka.duplicateOf as { name: string }).name).toBe('مصنع البركة للأغذية');
    expect(baraka.confidence).toBe(0.54); // no valid evidence -> confidence × 0.6

    const [usage] = await ownerQuery<{ c: string }>('SELECT sum(cost_usd)::text AS c FROM ai_usage WHERE tenant_id = $1', [tenantId]);
    expect(Number(usage!.c)).toBeCloseTo(0.02); // 2 web searches × $0.01 (fake model tokens are free)

    // Running the same search again does not propose the same companies twice.
    const again = (await owner.post('/ai/prospecting/search', { query: 'مصانع أغذية تحتاج نقل مبرد', city: 'الرياض' }).expect(201)).body;
    expect(again.found).toBe(0);
    expect(again.dropped.map((d: { reason: string }) => d.reason)).toContain('already_proposed');
  });

  it('accepting creates the account with its source; rejecting needs a reason', async () => {
    fake(app).on('prospecting', () => ({
      __sources: [{ url: 'https://dir.example.sa/a', title: 'A' }],
      candidates: [{ name: 'شركة الأفق للتجارة', website: 'ufuq.sa', city: 'جدة', region: 'مكة', industry: 'تجارة', phone: null, whyFit: 'توزيع', fitEvidence: [], sourceUrl: 'https://dir.example.sa/a', confidence: 0.7 }],
    }));
    await owner.post('/ai/prospecting/search', { query: 'شركات توزيع في جدة' }).expect(201);
    const [p] = (await owner.get('/ai/prospecting/prospects').expect(200)).body;
    await owner.post(`/ai/prospecting/prospects/${p.id}/reject`, { reason: '' }).expect(400);
    const accepted = (await owner.post(`/ai/prospecting/prospects/${p.id}/accept`).expect(200)).body;
    expect(accepted.status).toBe('accepted');
    const acc = (await owner.get(`/crm/accounts/${accepted.accountId}`).expect(200)).body;
    expect(acc).toMatchObject({ name: 'شركة الأفق للتجارة', city: 'جدة', leadSource: 'prospecting', leadSourceDetail: 'https://dir.example.sa/a', websiteDomain: 'ufuq.sa' });
    await owner.post(`/ai/prospecting/prospects/${p.id}/accept`).expect(409);
  });

  it('from supplied text: only companies that appear in the text', async () => {
    fake(app).on('prospecting', (req) => {
      expect(req.webSearch).toBeUndefined();
      expect(req.prompt).toContain('<untrusted_data source="company_supplied_list">');
      return {
        candidates: [
          { name: 'مؤسسة الريادة', website: null, city: 'الدمام', region: null, industry: null, phone: null, whyFit: 'عارض', fitEvidence: [], sourceUrl: 'manual', confidence: 0.6 },
          { name: 'شركة ليست في القائمة', website: null, city: null, region: null, industry: null, phone: null, whyFit: 'x', fitEvidence: [], sourceUrl: 'manual', confidence: 0.6 },
        ],
      };
    });
    const s = (await owner.post('/ai/prospecting/from-text', { text: 'قائمة العارضين: مؤسسة الريادة (الدمام)، شركة المدار (الرياض)', sourceLabel: 'قائمة معرض النقل 2026' }).expect(201)).body;
    expect(s).toMatchObject({ source: 'manual', found: 1, dropped: [{ reason: 'not_in_text' }] });
    const [p] = (await owner.get('/ai/prospecting/prospects').expect(200)).body;
    expect(p.sourceUrl).toBe(`manual:${s.id}`);
    expect(p.sourceTitle).toBe('قائمة معرض النقل 2026');
  });

  it('readonly users cannot prospect', async () => {
    const { client: ro } = await addMember(app, owner, 'ro@agents.sa', 'readonly');
    await ro.post('/ai/prospecting/search', { query: 'مصانع في الرياض' }).expect(403);
  });

  it('matches citation URLs strictly', () => {
    expect(sameUrl('https://www.a.sa/x/', 'https://a.sa/x')).toBe(true);
    expect(sameUrl('https://a.sa/x?id=1', 'https://a.sa/x?id=2')).toBe(false);
    expect(sameUrl('https://a.sa/x', 'https://b.sa/x')).toBe(false);
    expect(sameUrl('not a url', 'not a url')).toBe(false);
  });
});

describe('Ask Rakan', () => {
  it('answers through tools, links only records it mentions, and keeps the conversation', async () => {
    const a = (await owner.post('/crm/accounts', { name: 'مصنع الواحة', city: 'الرياض' }).expect(201)).body;
    await owner.post('/crm/accounts', { name: 'عميل آخر' }).expect(201);
    let round = 0;
    fake(app).onChat('assistant', (req) => {
      round++;
      if (round === 1) {
        expect(req.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['search_accounts', 'needs_attention', 'pipeline_summary', 'find_prospects']));
        return [{ type: 'text', text: 'سأبحث.' }, { type: 'tool_use', id: 't1', name: 'search_accounts', input: { query: 'الواحة' } }];
      }
      const result = req.messages.at(-1)!.content[0] as { type: string; content: string };
      expect(result.type).toBe('tool_result');
      expect(result.content).toContain(a.id);
      return [{ type: 'text', text: 'وجدت عميلاً واحداً: مصنع الواحة في الرياض.' }];
    });
    const c = (await owner.post('/ai/assistant/messages', { message: 'ابحث عن عميل الواحة' }).expect(200)).body;
    const last = c.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', content: 'وجدت عميلاً واحداً: مصنع الواحة في الرياض.' });
    expect(last.toolCalls).toEqual([{ tool: 'search_accounts', ok: true, summary: '1/1' }]);
    expect(last.links).toEqual([{ label: 'مصنع الواحة', href: `/accounts/${a.id}` }]);

    // Follow-up message carries the history.
    fake(app).onChat('assistant', (req) => {
      expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      return [{ type: 'text', text: 'تمام.' }];
    });
    const c2 = (await owner.post('/ai/assistant/messages', { conversationId: c.id, message: 'شكراً' }).expect(200)).body;
    expect(c2.messages).toHaveLength(4);
    expect((await owner.get('/ai/assistant/conversations').expect(200)).body).toHaveLength(1);
  });

  it('validates tool input, refuses unknown tools, and respects permissions and record scope', async () => {
    const { client: rep, membershipId } = await addMember(app, owner, 'rep2@agents.sa', 'rep');
    await owner.post('/crm/accounts', { name: 'عميل المندوب', ownerMembershipId: membershipId }).expect(201);
    await owner.post('/crm/accounts', { name: 'عميل سري للمالك' }).expect(201);
    let round = 0;
    fake(app).onChat('assistant', (req) => {
      round++;
      if (round === 1) {
        expect(req.tools.map((t) => t.name)).not.toContain('pipeline_summary'); // reps lack reports.read
        return [
          { type: 'tool_use', id: 'a', name: 'get_account', input: { accountId: 'not-a-uuid' } },
          { type: 'tool_use', id: 'b', name: 'pipeline_summary', input: {} },
          { type: 'tool_use', id: 'c', name: 'search_accounts', input: {} },
        ];
      }
      const blocks = req.messages.at(-1)!.content as { content: string; isError: boolean }[];
      expect(blocks[0]!.content).toContain('invalid_input');
      expect(blocks[1]!.content).toContain('unknown_tool');
      expect(blocks[2]!.content).toContain('عميل المندوب');
      expect(blocks[2]!.content).not.toContain('عميل سري للمالك');
      return [{ type: 'text', text: 'لديك عميل واحد.' }];
    });
    const c = (await rep.post('/ai/assistant/messages', { message: 'كم عميل عندي؟' }).expect(200)).body;
    expect(c.messages.at(-1).toolCalls.map((x: { ok: boolean }) => x.ok)).toEqual([false, false, true]);
    // Conversations are private, even from the owner.
    await owner.get(`/ai/assistant/conversations/${c.id}`).expect(404);
  });

  it('stops after too many tool rounds and is budgeted like every agent', async () => {
    fake(app).onChat('assistant', () => [{ type: 'tool_use', id: String(Math.random()), name: 'needs_attention', input: {} }]);
    const c = (await owner.post('/ai/assistant/messages', { message: 'حلقة' }).expect(200)).body;
    expect(c.messages.at(-1).content).toContain('خطوات كثيرة');
    expect(c.messages.at(-1).toolCalls).toHaveLength(6);
    await owner.patch('/ai/settings', { monthlyBudgetUsd: 0 }).expect(200);
    expect((await owner.post('/ai/assistant/messages', { message: 'مرحبا' }).expect(402)).body.error.code).toBe('AI_BUDGET_EXCEEDED');
  });
});
