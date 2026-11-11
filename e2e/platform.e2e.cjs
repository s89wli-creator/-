/**
 * Phase 6 (platform console) in the browser: operator access, overview, suspending and reactivating a
 * company (the company sees it immediately), plan editing, and the company's "Plan & usage" page.
 * Requires the API + web running and MIGRATION_DATABASE_URL (to grant operator access via the CLI).
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const OUT = process.env.E2E_OUT ?? path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const log = (...a) => console.log('•', ...a);
const assert = (c, m) => { if (!c) throw new Error(m); };

async function register(browser, company, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/register');
  await page.fill('#companyName', company);
  await page.fill('#fullName', 'مالك ' + company);
  await page.fill('#email', email);
  await page.fill('#password', 'correct-horse-battery');
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.waitForURL('**/home');
  return page;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ops = await register(browser, 'فريق راكان', 'ops@e2e.sa');
  const acme = await register(browser, 'شركة الأفق', 'owner@ufuq.sa');
  for (const p of [ops, acme]) p.on('pageerror', (e) => errors.push(e.message));

  // A company owner cannot open the console
  await acme.goto(BASE + '/platform');
  await acme.getByText('هذه الصفحة لفريق تشغيل راكان فقط').waitFor();
  log('console refused to a company owner');

  // Grant operator access (CLI only, never from the web app)
  execFileSync('node', [path.join(__dirname, '../scripts/platform-grant.mjs'), 'ops@e2e.sa'], { stdio: 'inherit' });
  await ops.reload();
  await ops.getByRole('link', { name: 'إدارة المنصة' }).click();
  await ops.getByRole('heading', { name: 'نظرة عامة على المنصة' }).waitFor();
  await ops.screenshot({ path: `${OUT}/platform-01-overview.png`, fullPage: true });

  // Company list → detail → suspend (needs a reason and a second confirmation)
  await ops.getByRole('link', { name: 'الشركات' }).first().click();
  await ops.getByRole('link', { name: 'شركة الأفق' }).click();
  await ops.getByRole('heading', { name: 'شركة الأفق' }).waitFor();
  await ops.selectOption('#status', 'suspended');
  await ops.fill('#reason', 'تعثر السداد — اختبار');
  await ops.getByRole('button', { name: 'حفظ' }).click();
  await ops.getByText('الإيقاف يمنع جميع مستخدمي الشركة').waitFor();
  await ops.getByRole('button', { name: 'تأكيد الإيقاف' }).click();
  await ops.getByText('موقوفة', { exact: true }).first().waitFor();
  await ops.getByText('تعثر السداد — اختبار').waitFor();
  await ops.screenshot({ path: `${OUT}/platform-02-company.png`, fullPage: true });
  log('company suspended with a reason');

  await acme.goto(BASE + '/accounts');
  await acme.getByText('حساب الشركة موقوف').first().waitFor();
  log('the company sees the suspension immediately');

  await ops.selectOption('#status', 'active');
  await ops.fill('#reason', 'تم السداد');
  await ops.getByRole('button', { name: 'حفظ' }).click();
  await ops.getByText('نشطة', { exact: true }).first().waitFor();
  await acme.goto(BASE + '/accounts');
  await acme.getByRole('heading', { name: 'العملاء' }).waitFor();
  assert((await acme.getByText('حساب الشركة موقوف').count()) === 0, 'still suspended after reactivation');
  log('reactivated');

  // Plans are data: edit a price
  await ops.getByRole('link', { name: 'الباقات' }).click();
  await ops.getByRole('heading', { name: 'الباقات' }).waitFor();
  await ops.locator('section', { hasText: 'Team' }).getByRole('button', { name: 'تعديل' }).click();
  await ops.fill('#price', '949');
  await ops.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
  await ops.getByText('949 ر.س/شهر').waitFor();
  await ops.getByRole('dialog').getByRole('button', { name: 'حفظ' }).waitFor({ state: 'hidden' }).catch(() => undefined);
  await ops.goto(BASE + '/platform/audit');
  await ops.getByText('تعديل باقة').first().waitFor();
  log('plan edited and logged');

  // Spokesperson voice: honest "not configured" without a provider key; nothing can be recorded or sent
  await ops.goto(BASE + '/platform/voice');
  await ops.getByRole('heading', { name: 'صوت راكان الرسمي' }).waitFor();
  await ops.getByText('لم يُضبط مفتاح مزود الصوت').waitFor();
  await ops.getByText('أقرّ بأن هذا التسجيل بصوتي أنا').waitFor();
  assert(await ops.getByRole('button', { name: 'ابدأ التسجيل' }).isDisabled(), 'recording must be disabled without a voice provider');
  assert(await ops.getByRole('button', { name: 'إنشاء الصوت' }).isDisabled(), 'create must be disabled without a voice provider');
  await ops.screenshot({ path: `${OUT}/platform-04-voice.png`, fullPage: true });
  await acme.goto(BASE + '/platform/voice');
  await acme.getByText('هذه الصفحة لفريق تشغيل راكان فقط.').first().waitFor();
  assert((await acme.getByText('أقرّ بأن هذا التسجيل بصوتي أنا').count()) === 0, 'voice page leaked to a company user');
  log('voice setup page (not configured)');

  // The company's own view of its plan
  await acme.goto(BASE + '/settings/billing');
  await acme.getByRole('heading', { name: 'الباقة والاستهلاك' }).waitFor();
  await acme.getByText('949 ر.س/شهر').waitFor();
  await acme.screenshot({ path: `${OUT}/platform-03-billing.png`, fullPage: true });

  assert(errors.length === 0, `page errors:\n${errors.join('\n')}`);
  log('PLATFORM E2E PASSED');
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
