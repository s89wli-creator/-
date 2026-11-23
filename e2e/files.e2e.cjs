/** Attachments (upload, content check, download, delete) and the push alerts switch, in the browser. */
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${page.url()} :: ${e.message}`));
  const toast = (text) => page.getByRole('status').filter({ hasText: text }).first().waitFor();

  await page.goto(BASE + '/register');
  await page.fill('#companyName', 'شركة الملفات');
  await page.fill('#fullName', 'هند المالكة');
  await page.fill('#email', 'files@e2e.sa');
  await page.fill('#password', 'correct-horse-battery');
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.waitForURL('**/home');
  const account = await page.evaluate(async () => {
    const csrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('rakan_csrf='))?.split('=')[1] ?? '');
    const r = await fetch('/api/crm/accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'شركة الألبان' }) });
    return r.json();
  });

  await page.goto(`${BASE}/accounts/${account.id}`);
  await page.getByRole('tab', { name: 'المرفقات' }).click();
  await page.getByText('لا توجد مرفقات.').waitFor();
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(3000, 32), Buffer.from('\n%%EOF')]);
  await page.getByLabel('إرفاق ملف').setInputFiles({ name: 'عقد التوريد.pdf', mimeType: 'application/pdf', buffer: pdf });
  await toast('تم إرفاق الملف');
  await page.getByText('عقد التوريد.pdf').waitFor();

  // A disguised file is refused (content does not match the name).
  await page.getByLabel('إرفاق ملف').setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('<html><script>alert(1)</script></html>') });
  await page.getByText('نوع الملف غير مقبول').waitFor();
  await page.screenshot({ path: `${OUT}/files-01-account.png`, fullPage: true });

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /تنزيل عقد التوريد.pdf/ }).click()]);
  // The Arabic name travels in the standard RFC 6266 header (this headless browser cannot save non-Latin names itself).
  const head = await page.request.get(download.url());
  assert(head.headers()['content-disposition'].includes(`filename*=UTF-8''${encodeURIComponent('عقد التوريد.pdf')}`), 'missing UTF-8 file name');
  const saved = fs.readFileSync(await download.path());
  assert(Buffer.compare(saved, pdf) === 0, 'downloaded bytes differ');
  log('upload, content check and download');

  await page.getByRole('button', { name: 'حذف الملف' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'تأكيد' }).click();
  await toast('تم حذف الملف');
  await page.getByText('لا توجد مرفقات.').waitFor();
  log('delete');

  // Push alerts switch lives in the notifications panel; without platform keys it says so honestly.
  await page.getByRole('button', { name: /الإشعارات/ }).first().click();
  // Without platform keys it says so honestly (CI); with keys it offers to turn alerts on for this device.
  // (Headless browsers report notifications as blocked, which the panel also explains.)
  await page.getByText('تنبيهات على هذا الجهاز').waitFor();
  const configured = (await page.getByText('التنبيهات غير مفعّلة على المنصة بعد.').count()) === 0;
  await page.screenshot({ path: `${OUT}/files-02-push.png` });
  log(`push switch shown (${configured ? 'keys present' : 'not configured'})`);

  assert(errors.length === 0, `page errors:\n${errors.join('\n')}`);
  log('FILES E2E PASSED');
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
