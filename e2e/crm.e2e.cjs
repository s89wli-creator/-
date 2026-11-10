/**
 * Phase 3 end-to-end (real browser, Arabic RTL): import -> account -> contact -> opportunity -> visit
 * -> rep on phone: check-in (geolocation) + outcome -> follow-up task -> owner: pipeline move to won -> dashboard.
 * Requires API (MAIL_TRANSPORT=log -> E2E_MAIL_LOG) and web running on an empty database.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = process.env.E2E_OUT ?? path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const MAIL_LOG = process.env.E2E_MAIL_LOG ?? '/tmp/api-e2e.log';
const log = (...a) => console.log('•', ...a);

async function noOverflow(page, name) {
  await page.waitForLoadState('networkidle');
  const o = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (o) throw new Error(`horizontal overflow on ${name}`);
  log(`${name}: no horizontal overflow`);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p) => {
    p.on('console', (m) => m.type() === 'error' && errors.push(`${p.url()} :: ${m.text()}`));
    p.on('pageerror', (e) => errors.push(`${p.url()} :: ${e.message}`));
  };
  const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const owner = await ownerCtx.newPage();
  watch(owner);
  globalThis.__pages = [owner];
  const nav = (name) => owner.getByRole('navigation').getByRole('link', { name, exact: true }).click();

  // Register
  await owner.goto(BASE + '/register');
  await owner.fill('#companyName', 'انجزني التجريبية');
  await owner.fill('#fullName', 'مدير المبيعات');
  await owner.fill('#email', 'manager@crm-e2e.sa');
  await owner.fill('#password', 'correct-horse-battery');
  await owner.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await owner.waitForURL('**/home');

  // Invite a rep and accept on phone
  await nav('فريق العمل');
  await owner.getByRole('button', { name: 'دعوة عضو' }).click();
  await owner.fill('#invite-email', 'rep@crm-e2e.sa');
  await owner.getByRole('dialog').getByRole('button', { name: 'دعوة عضو' }).click();
  await owner.getByText('تم إرسال الدعوة إلى rep@crm-e2e.sa').waitFor();
  await new Promise((r) => setTimeout(r, 400));
  const link = [...fs.readFileSync(MAIL_LOG, 'utf8').matchAll(/http:\/\/localhost:3000\/invite\/([A-Za-z0-9_\-%]+)/g)].pop()[0];
  const repCtx = await browser.newContext({
    viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true,
    geolocation: { latitude: 24.7136, longitude: 46.6753, accuracy: 15 }, permissions: ['geolocation'],
  });
  const rep = await repCtx.newPage();
  watch(rep);
  globalThis.__pages.push(rep);
  await rep.goto(link);
  await rep.fill('#fullName', 'سعد المندوب');
  await rep.fill('#password', 'rep-strong-passphrase');
  await rep.getByRole('button', { name: 'قبول الدعوة' }).click();
  await rep.waitForURL('**/home');
  log('rep joined');

  // CRM settings: add a track
  await nav('إعدادات المبيعات');
  await owner.fill('#tr-name', 'طالبو النقل');
  await owner.fill('#tr-key', 'shippers');
  await owner.getByRole('button', { name: 'إضافة' }).first().click();
  await owner.getByText('طالبو النقل', { exact: true }).first().waitFor();
  log('track created');

  // Import CSV (one duplicate inside the file)
  const csvPath = path.join(OUT, 'e2e-import.csv');
  fs.writeFileSync(csvPath, '﻿اسم الشركة,المدينة,السجل التجاري,اسم المسؤول,جوال المسؤول,المسار\n' +
    'مصنع الأمل للأغذية,الرياض,1010000001,خالد العتيبي,0501112222,طالبو النقل\n' +
    'مستودعات الشمال,حائل,1010000002,,,طالبو النقل\n' +
    'شركة مصنع الأمل للأغذية المحدودة,الرياض,,,,طالبو النقل\n');
  await nav('العملاء');
  await owner.getByRole('link', { name: 'استيراد' }).first().click();
  await owner.setInputFiles('input[type=file]', csvPath);
  await owner.getByRole('button', { name: 'رفع وقراءة الملف' }).click();
  await owner.getByText('وجدنا 3 صفاً و6 عموداً').waitFor();
  if ((await owner.inputValue('#map-name')) !== 'اسم الشركة') throw new Error('auto-mapping failed');
  await owner.screenshot({ path: `${OUT}/p3-01-import-mapping.png`, fullPage: true });
  await owner.getByRole('button', { name: 'تحليل الصفوف' }).click();
  await owner.getByText('يجب تأكيد صلاحية استخدام البيانات.').waitFor();
  log('import blocked without data-permission confirmation');
  await owner.getByLabel(/أؤكد أن لدى الشركة حقاً نظامياً/).check();
  await owner.getByRole('button', { name: 'تحليل الصفوف' }).click();
  await owner.getByText('3 صالح · 0 غير صالح · 1 مكرر محتمل').waitFor();
  await owner.getByText('مكرر داخل الملف').waitFor();
  await owner.screenshot({ path: `${OUT}/p3-02-import-review.png`, fullPage: true });
  await owner.getByRole('button', { name: 'تنفيذ الاستيراد' }).click();
  await owner.getByText('اكتمل الاستيراد: 2 جديد، 0 مدموج، 1 متخطى.').waitFor();
  log('import executed (duplicate skipped)');

  // Accounts list + search (Arabic-insensitive)
  await owner.getByRole('link', { name: 'عرض العملاء' }).click();
  await owner.fill('#acc-q', 'الامل');
  await owner.getByRole('link', { name: /مصنع الأمل للأغذية/ }).waitFor();
  await owner.getByRole('link', { name: /مصنع الأمل للأغذية/ }).click();
  await owner.getByRole('heading', { name: 'مصنع الأمل للأغذية' }).waitFor();

  // Assign to rep
  await owner.getByRole('button', { name: 'تعديل', exact: true }).click();
  await owner.selectOption('#acc-owner', { label: 'سعد المندوب' });
  await owner.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
  await owner.getByText('سعد المندوب').first().waitFor();

  // Contacts tab shows the imported (encrypted) contact; mark another contact do-not-contact
  await owner.getByRole('tab', { name: /جهات الاتصال/ }).click();
  await owner.getByText('خالد العتيبي').waitFor();
  await owner.getByText('+966501112222').waitFor();

  // Opportunity
  await owner.getByRole('tab', { name: /الفرص/ }).click();
  await owner.getByRole('button', { name: 'فرصة جديدة' }).click();
  await owner.fill('#opp-title', 'عقد نقل مبرد سنوي');
  await owner.fill('#opp-amount', '120000');
  await owner.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
  await owner.getByText('عقد نقل مبرد سنوي').waitFor();

  // Schedule a visit today (in 1 hour) linked to the opportunity
  await owner.getByRole('button', { name: 'جدولة زيارة' }).click();
  const inOneHour = new Date(Date.now() + 3600_000 + 3 * 3600_000).toISOString().slice(0, 16);
  await owner.fill('#visit-start', inOneHour);
  await owner.selectOption('#visit-opp', { label: 'عقد نقل مبرد سنوي' });
  await owner.fill('#visit-purpose', 'عرض خدمة النقل المبرد');
  await owner.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
  await owner.getByRole('tab', { name: /الزيارات/ }).waitFor();
  await owner.getByText('عرض خدمة النقل المبرد').first().waitFor();
  await owner.screenshot({ path: `${OUT}/p3-03-account-visits.png`, fullPage: true });
  log('opportunity + visit created');

  // Rep: today's visit on the phone, check-in with location, record outcome
  await rep.goto(BASE + '/home');
  await rep.getByRole('link', { name: /مصنع الأمل للأغذية/ }).click();
  await noOverflow(rep, 'visit (360px)');
  await rep.getByRole('button', { name: 'وصلت — بدء الزيارة' }).click();
  await rep.getByText(/بدأت .* · مع الموقع/).waitFor();
  log('rep checked in with location');
  const t0 = Date.now();
  await rep.getByText('مهتم', { exact: true }).click();
  await rep.getByRole('button', { name: 'مستوى الاهتمام 4' }).click();
  await rep.getByText('إرسال عرض', { exact: true }).click();
  await rep.getByText('بعد 3 أيام', { exact: true }).click();
  await rep.fill('#visit-notes', 'العميل مهتم بالنقل المبرد ويطلب عرض سعر.');
  await rep.screenshot({ path: `${OUT}/p3-04-visit-outcome-mobile.png`, fullPage: true });
  await rep.getByRole('button', { name: 'حفظ' }).click();
  await rep.getByText('أُنشئت مهمة متابعة تلقائياً.').waitFor();
  log(`rep recorded the outcome in ${Math.round((Date.now() - t0) / 1000)}s of interaction`);
  await rep.goto(BASE + '/tasks');
  await rep.getByText('إرسال العرض التجاري').waitFor();
  await noOverflow(rep, 'tasks (360px)');
  log('follow-up task visible to rep');

  // Rep cannot see unassigned accounts
  await rep.goto(BASE + '/accounts');
  await rep.getByText('مصنع الأمل للأغذية').waitFor();
  if (await rep.getByText('مستودعات الشمال').count()) throw new Error('rep sees an account not assigned to them');
  await noOverflow(rep, 'accounts (360px)');
  log('rep scope enforced in UI');

  // Owner: pipeline shows the deal in "تمت الزيارة" (moved by the visit event); move to won with a reason
  await nav('خط المبيعات');
  const visitDone = owner.getByRole('listitem', { name: 'تمت الزيارة' });
  await visitDone.getByText('عقد نقل مبرد سنوي').waitFor();
  log('deal advanced to "visit done" automatically');
  await visitDone.getByRole('button', { name: 'نقل إلى' }).click();
  await owner.selectOption('#mv-stage', { label: 'فوز بالصفقة' });
  await owner.getByRole('button', { name: 'تأكيد' }).click();
  await owner.getByRole('dialog').getByRole('alert').filter({ hasText: 'اختر سبباً لهذه المرحلة' }).waitFor();
  log('closing without a reason is blocked');
  await owner.selectOption('#mv-reason', { label: 'جودة الخدمة' });
  await owner.getByRole('button', { name: 'تأكيد' }).click();
  await owner.getByRole('listitem', { name: 'فوز بالصفقة' }).getByText('عقد نقل مبرد سنوي').waitFor();
  await owner.screenshot({ path: `${OUT}/p3-05-pipeline.png`, fullPage: true });
  log('deal won with reason');

  // Dashboard
  await nav('لوحة القياس');
  const won = owner.locator('section', { hasText: 'صفقات رابحة' }).first();
  await won.getByText('1', { exact: true }).waitFor();
  await owner.getByText('100%').first().waitFor();
  await owner.screenshot({ path: `${OUT}/p3-06-dashboard.png`, fullPage: true });
  log('dashboard reflects the won deal');

  // Owner on phone: key pages do not overflow
  const ownerPhone = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, storageState: await ownerCtx.storageState() });
  const op = await ownerPhone.newPage();
  watch(op);
  for (const p of ['/dashboard', '/accounts', '/pipeline', '/visits', '/tasks', '/settings/crm', '/accounts/import']) {
    await op.goto(BASE + p);
    await noOverflow(op, `${p} (360px owner)`);
  }
  await op.goto(BASE + '/dashboard');
  await op.waitForLoadState('networkidle');
  await op.screenshot({ path: `${OUT}/p3-07-dashboard-mobile.png`, fullPage: true });

  const relevant = errors.filter((e) => !/status of 40[134]/.test(e));
  log('console errors:', relevant.length ? relevant : 'none');
  await browser.close();
  if (relevant.length) process.exit(1);
  console.log('CRM E2E PASSED');
})().catch(async (e) => {
  console.error('CRM E2E FAILED:', e.message);
  for (const [i, pg] of (globalThis.__pages ?? []).entries()) await pg.screenshot({ path: `${OUT}/failure-${i}.png`, fullPage: true }).catch(() => {});
  process.exit(1);
});
