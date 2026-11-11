/**
 * Proposals in the browser: price list -> draft -> approval -> customer link -> acceptance, print view,
 * and the customer page on a phone. Requires the API and the web app running.
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
  const call = (path, method, body) => page.evaluate(async ({ path, method, body }) => {
    const csrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('rakan_csrf='))?.split('=')[1] ?? '');
    const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }, { path, method, body });

  await page.goto(BASE + '/register');
  await page.fill('#companyName', 'شركة النقل المبرد');
  await page.fill('#fullName', 'سعد المالك');
  await page.fill('#email', 'quotes@e2e.sa');
  await page.fill('#password', 'correct-horse-battery');
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.waitForURL('**/home');

  // Approved price list + commercial policy (the terms), a customer and a contact.
  for (const item of [
    { section: 'pricing', title: 'سعر رحلة مبردة', fields: { product: 'رحلة نقل مبرد الرياض-الدمام', price: 1200, unit: 'رحلة' } },
    { section: 'commercial_policy', title: 'شروط الدفع', body: 'الدفع خلال 30 يوماً من تاريخ الفاتورة.' },
  ]) {
    const it = await call('/brain/items', 'POST', item);
    await call(`/brain/items/${it.id}/approve`, 'POST');
  }
  const account = await call('/crm/accounts', 'POST', { name: 'مصنع ألبان الشرقية', city: 'الدمام' });
  await call(`/crm/accounts/${account.id}/contacts`, 'POST', { fullName: 'خالد المشتريات', email: 'buyer@dairy.sa' });

  // New proposal from the customer page.
  await page.goto(`${BASE}/accounts/${account.id}`);
  await page.getByRole('tab', { name: /عروض الأسعار/ }).click();
  await page.getByRole('button', { name: 'عرض سعر جديد' }).click();
  await page.selectOption('#contactId', { label: 'خالد المشتريات' });
  await page.fill('#title', 'عرض نقل مبرد شهري');
  await page.getByRole('button', { name: 'إنشاء المسودة' }).click();
  await page.waitForURL('**/proposals/*');
  await page.getByText('أضف بنداً واحداً على الأقل.').first().waitFor();

  // Lines: from the approved list (price fixed) + a manual line (flagged).
  await page.selectOption('#add-price', { index: 1 });
  await page.getByLabel('الكمية').first().fill('3');
  await page.getByLabel('الخصم %').first().fill('5');
  await page.getByRole('button', { name: 'بند خارج القائمة' }).click();
  await page.getByLabel('البند', { exact: true }).last().fill('تأمين الشحنة');
  await page.getByLabel('سعر الوحدة').last().fill('150');
  await page.getByText('3,570.00').first().waitFor(); // 3 x 1200 - 5% + 150 = 3570
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await toast('تم الحفظ');
  await page.getByText('سعر يدوي خارج القائمة: تأمين الشحنة').waitFor();
  await page.getByText('4,105.50').first().waitFor(); // + 15% VAT
  await page.getByText('الدفع خلال 30 يوماً').first().waitFor(); // terms from the approved policy
  await page.screenshot({ path: `${OUT}/proposals-01-editor.png`, fullPage: true });
  log('draft priced from the approved list, totals with VAT');

  await page.getByRole('button', { name: 'إرسال للموافقة' }).click();
  await toast('أُرسل للموافقة');
  await page.getByText('بانتظار الموافقة').first().waitFor();

  // Approve in the inbox: only then the link exists.
  await page.goto(BASE + '/approvals');
  await page.getByText(/عرض السعر Q-\d{4}-0001/).first().waitFor();
  await page.screenshot({ path: `${OUT}/proposals-02-approval.png`, fullPage: true });
  await page.getByRole('button', { name: 'موافقة وإرسال' }).first().click();
  await toast('تمت الموافقة والتنفيذ');
  await page.goto(BASE + '/proposals');
  await page.getByRole('link', { name: /عرض نقل مبرد شهري/ }).click();
  await page.getByRole('heading', { name: 'رابط العميل' }).waitFor();
  const link = await page.locator('input[readonly][dir="ltr"]').inputValue();
  assert(/\/p\/[A-Za-z0-9_-]{32}$/.test(link), `bad share link ${link}`);
  log('approved; customer link issued');

  // The customer: no account, on a phone.
  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const c = await phone.newPage();
  c.on('pageerror', (e) => errors.push(`customer :: ${e.message}`));
  await c.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await c.getByText('مصنع ألبان الشرقية').first().waitFor();
  await c.getByText('4,105.50').first().waitFor();
  const overflow = await c.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert(!overflow, 'horizontal overflow on the customer page (phone)');
  await c.screenshot({ path: `${OUT}/proposals-03-customer-phone.png`, fullPage: true });
  await c.getByRole('button', { name: 'أوافق على العرض' }).click();
  await c.fill('#name', 'خالد المشتريات');
  await c.getByRole('button', { name: 'تأكيد الموافقة' }).click();
  await c.getByText('تم تسجيل موافقتك').waitFor();
  await c.screenshot({ path: `${OUT}/proposals-04-accepted.png`, fullPage: true });
  log('customer accepted from the link');

  await page.reload();
  await page.getByText('قبله العميل').first().waitFor();
  await page.getByText('رد العميل: خالد المشتريات').waitFor();

  // Print view (PDF from the browser).
  await page.goto(page.url().replace('/proposals/', '/print/proposals/'));
  await page.getByRole('button', { name: 'طباعة / PDF' }).waitFor();
  await page.getByText('شركة النقل المبرد').first().waitFor();
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({ path: `${OUT}/proposals-05-print.png`, fullPage: true });
  log('print view');

  assert(errors.length === 0, `page errors:\n${errors.join('\n')}`);
  log('PROPOSALS E2E PASSED');
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
