/**
 * Phase 5 in the browser (phone, Arabic RTL): installable app, "My day", working without a connection
 * (cached screens + outbox), automatic sync on reconnect with no duplicates, and voice notes with consent.
 * Requires the API and the web app running (production build, so the service worker is active).
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
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    permissions: ['geolocation', 'microphone'], geolocation: { latitude: 24.7136, longitude: 46.6753, accuracy: 15 },
  });
  const page = await ctx.newPage();
  const errors = [];
  let offline = false;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // While offline the browser logs failed requests; those are expected.
    if (m.type() === 'error' && !offline && !/Failed to load resource|Failed to fetch|NetworkError/.test(m.text())) errors.push(m.text());
  });
  const api = (p, method = 'GET', body) => page.evaluate(async ([p, method, body]) => {
    const csrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('rakan_csrf='))?.split('=')[1] ?? '');
    const r = await fetch('/api' + p, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: body ? JSON.stringify(body) : undefined });
    return r.status === 204 ? null : r.json();
  }, [p, method, body]);

  // ---- Owner who also works in the field
  await page.goto(BASE + '/register');
  await page.fill('#companyName', 'شركة الميدان التجريبية');
  await page.fill('#fullName', 'فهد الميداني');
  await page.fill('#email', 'field@e2e.sa');
  await page.fill('#password', 'correct-horse-battery');
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.waitForURL('**/home');
  await api('/tenant', 'PATCH', { settings: { recordingEnabled: true, recordingRetentionDays: 60 } });
  const acc = await api('/crm/accounts', 'POST', { name: 'مستودعات الشرق', city: 'الرياض', address: 'حي السلي', lat: 24.62, lng: 46.83 });
  await api(`/crm/accounts/${acc.id}/contacts`, 'POST', { fullName: 'أبو سعد', phone: '0551112233', isPrimary: true });
  const visit = await api('/crm/visits', 'POST', { accountId: acc.id, scheduledStart: new Date(Date.now() + 3600_000).toISOString(), purpose: 'عرض خدمة النقل المبرد' });
  log('data ready');

  // ---- Installable: manifest + service worker controlling the page
  await page.goto(BASE + '/field');
  await page.getByRole('heading', { name: 'يومي' }).waitFor();
  const manifest = await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.getAttribute('href'));
  assert(manifest === '/manifest.webmanifest', 'manifest link missing');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
  log('service worker active');

  const card = page.getByRole('link', { name: /مستودعات الشرق/ });
  await card.waitFor();
  assert(await page.getByRole('link', { name: 'الاتجاهات' }).getAttribute('href') === 'https://www.google.com/maps/dir/?api=1&destination=24.62,46.83', 'directions link');
  assert((await page.getByRole('link', { name: /اتصال بـأبو سعد/ }).getAttribute('href')) === 'tel:+966551112233', 'call link');
  await page.screenshot({ path: `${OUT}/field-01-my-day.png`, fullPage: true });
  await card.click();
  await page.waitForURL(`**/visits/${visit.id}`);
  await page.getByRole('button', { name: 'وصلت — بدء الزيارة' }).waitFor();
  await page.waitForTimeout(800); // let the page be cached

  // ---- Offline: the visit still opens, actions are saved on the phone
  offline = true;
  await ctx.setOffline(true);
  await page.reload();
  await page.getByText('أنت غير متصل').waitFor();
  await page.getByRole('button', { name: 'وصلت — بدء الزيارة' }).click();
  await page.getByText('حُفظ على جهازك وسيُرسل تلقائياً').first().waitFor();
  await page.getByText('1 بانتظار الإرسال').waitFor();
  await page.getByRole('radio', { name: 'مهتم', exact: true }).check({ force: true });
  await page.getByRole('radio', { name: 'إرسال عرض' }).check({ force: true });
  await page.fill('#visit-notes', 'العميل يحتاج 10 رحلات مبردة شهرياً');
  await page.getByRole('button', { name: 'حفظ' }).last().click();
  await page.getByText('2 بانتظار الإرسال').waitFor();
  await page.screenshot({ path: `${OUT}/field-02-offline-queued.png`, fullPage: true });
  log('check-in + outcome saved offline');

  // An unvisited page falls back to the offline page
  await page.goto(BASE + '/team').catch(() => undefined);
  await page.getByText('لا يوجد اتصال بالإنترنت').waitFor();
  await page.goto(BASE + `/visits/${visit.id}`);

  // ---- Back online: automatic sync, applied once, original times kept
  offline = false;
  await ctx.setOffline(false);
  // Wait until the outbox on the phone is empty (everything replayed).
  const outboxCount = () => page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('rakan-field');
    r.onsuccess = () => { const q = r.result.transaction('outbox', 'readonly').objectStore('outbox').count(); q.onsuccess = () => res(q.result); };
  }));
  for (let i = 0; (await outboxCount()) > 0; i++) {
    assert(i < 60, 'outbox did not drain after reconnecting');
    await page.waitForTimeout(500);
  }
  const v = await api(`/crm/visits/${visit.id}`);
  assert(v.status === 'completed' && v.outcome === 'interested', `visit not synced: ${v.status}`);
  assert(new Date(v.checkInAt) <= new Date(v.checkOutAt), 'times out of order');
  const timeline = await api(`/crm/accounts/${acc.id}/timeline`);
  assert(timeline.filter((x) => x.type === 'visit_completed').length === 1, 'outcome applied more than once');
  const tasks = await api(`/crm/tasks?view=all&accountId=${acc.id}`);
  assert(tasks.length === 1, `expected one follow-up task, got ${tasks.length}`);
  log('synced once after reconnect');

  // ---- Voice note with consent (fake microphone), resumable upload
  await page.reload();
  await page.getByRole('heading', { name: 'ملاحظات صوتية' }).waitFor();
  const start = page.getByRole('button', { name: 'بدء التسجيل' });
  assert(await start.isDisabled(), 'recording must need consent');
  await page.getByLabel(/أخذت موافقة العميل/).check();
  await start.click();
  await page.getByText('جارٍ التسجيل').waitFor();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'إيقاف وحفظ' }).click();
  await page.getByText('تم رفع التسجيل').waitFor({ timeout: 15000 });
  await page.locator('audio').first().waitFor();
  await page.getByRole('button', { name: 'إضافة النص' }).click();
  await page.locator('textarea[name="transcript"]').fill('قال العميل إن الموسم يبدأ في رمضان');
  await page.getByRole('button', { name: 'حفظ' }).last().click();
  await page.getByText('قال العميل إن الموسم يبدأ في رمضان').waitFor();
  await page.screenshot({ path: `${OUT}/field-03-voice-note.png`, fullPage: true });
  const recs = await api(`/crm/visits/${visit.id}/recordings`);
  assert(recs.length === 1 && recs[0].status === 'ready' && recs[0].sizeBytes > 1000, 'recording not stored');
  log('voice note recorded, uploaded and transcribed');

  // ---- Sign-out wipes the device copy
  await page.evaluate(() => document.querySelector('[aria-controls="mobile-drawer"]')?.click());
  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await page.waitForURL('**/login');
  const left = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('rakan-field');
    r.onsuccess = () => { const tx = r.result.transaction('cache', 'readonly'); const c = tx.objectStore('cache').count(); c.onsuccess = () => res(c.result); };
    r.onerror = () => res(-1);
  }));
  assert(left === 0, `device cache not wiped (${left} entries)`);
  log('sign-out wiped the device');

  assert(errors.length === 0, `console errors:\n${errors.join('\n')}`);
  log('FIELD E2E PASSED');
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
