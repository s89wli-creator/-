/**
 * Sales Coach + scheduled agents + notifications in the browser. Runs without an AI key:
 * AI jobs must say "skipped" honestly, rule-based jobs must work.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = process.env.E2E_OUT ?? path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const log = (...a) => console.log('•', ...a);
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${page.url()} :: ${e.message}`));
  const toast = (text) => page.getByRole('status').filter({ hasText: text }).first().waitFor();
  const call = (p, method, body) => page.evaluate(async ({ p, method, body }) => {
    const csrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('rakan_csrf='))?.split('=')[1] ?? '');
    const r = await fetch('/api' + p, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }, { p, method, body });

  await page.goto(BASE + '/register');
  await page.fill('#companyName', 'شركة المدرب');
  await page.fill('#fullName', 'نورة المديرة');
  await page.fill('#email', 'coach@e2e.sa');
  await page.fill('#password', 'correct-horse-battery');
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.waitForURL('**/home');

  const acc = await call('/crm/accounts', 'POST', { name: 'مستودعات الخليج', city: 'الرياض' });
  await call('/crm/visits', 'POST', { accountId: acc.id, scheduledStart: new Date(Date.now() + 5 * 60_000).toISOString() });
  await call('/crm/tasks', 'POST', { title: 'جهّز عرض السعر', accountId: acc.id, dueAt: new Date(Date.now() - 3600_000).toISOString() });

  // Scheduled agents: enable the morning brief, run it now, read the notification.
  await page.goto(BASE + '/settings/automation');
  await page.getByRole('heading', { name: 'المهام المجدولة' }).waitFor();
  await page.getByRole('switch', { name: /ملخص الصباح/ }).click();
  await toast('تم الحفظ');
  await page.getByText(/التشغيل القادم/).first().waitFor();
  await page.getByText('الذكاء الاصطناعي غير مفعّل على المنصة').first().waitFor(); // AI jobs warn honestly
  const runButtons = page.getByRole('button', { name: 'شغّل الآن' });
  await runButtons.nth(0).click();
  await toast('تم التشغيل: نجح');
  await runButtons.nth(1).click(); // visit briefs: needs AI -> skipped, nothing invented
  await toast('تم التشغيل: تُخطّي');
  await page.getByText('الذكاء الاصطناعي غير مفعّل', { exact: false }).last().waitFor();
  await page.screenshot({ path: `${OUT}/coach-01-automation.png`, fullPage: true });
  log('morning brief ran; AI job skipped honestly');

  await page.reload();
  const bell = page.getByRole('button', { name: /الإشعارات/ }).first();
  await page.getByRole('button', { name: /الإشعارات \(1 غير مقروءة\)/ }).first().waitFor();
  await bell.click();
  await page.getByRole('dialog', { name: 'الإشعارات' }).getByText('مستودعات الخليج').waitFor();
  await page.getByRole('dialog', { name: 'الإشعارات' }).getByText('جهّز عرض السعر').waitFor();
  await page.screenshot({ path: `${OUT}/coach-02-notifications.png` });
  await page.getByRole('button', { name: 'تعليم الكل كمقروء' }).click();
  await page.getByRole('button', { name: 'الإشعارات', exact: true }).first().waitFor();
  await page.keyboard.press('Escape');
  log('notification delivered and read');

  // Sales Coach: numbers without AI, team tab for managers; AI report button disabled with a reason.
  await page.goto(BASE + '/coach');
  await page.getByRole('heading', { name: 'مدرب المبيعات' }).waitFor();
  await page.getByText('زيارات مخططة').waitFor();
  assert(await page.getByRole('button', { name: 'اطلب تقرير المدرب' }).isDisabled(), 'coach report must be disabled without a provider');
  await page.getByRole('tab', { name: 'الفريق' }).click();
  await page.getByText('وسيط الفريق').first().waitFor();
  await page.screenshot({ path: `${OUT}/coach-03-team.png`, fullPage: true });
  log('coach numbers and team view');

  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  for (const url of ['/coach', '/settings/automation']) {
    await p2.goto(BASE + url);
    await p2.getByRole('heading', { level: 1 }).first().waitFor();
    const overflow = await p2.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert(!overflow, `horizontal overflow on ${url} (phone)`);
  }
  await p2.screenshot({ path: `${OUT}/coach-04-automation-phone.png`, fullPage: true });

  assert(errors.length === 0, `page errors:\n${errors.join('\n')}`);
  log('COACH E2E PASSED');
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
