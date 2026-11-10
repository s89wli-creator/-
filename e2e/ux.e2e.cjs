/**
 * UX behaviour checks (design-system/rakan/MASTER.md §7): themes, confirm dialog, toasts, reduced motion,
 * keyboard access, phone navigation. Screenshots for visual review in light + dark, desktop + phone.
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
  const watch = (p) => {
    p.on('console', (m) => m.type() === 'error' && errors.push(`${p.url()} :: ${m.text()}`));
    p.on('pageerror', (e) => errors.push(`${p.url()} :: ${e.message}`));
  };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  watch(page);
  globalThis.__pages = [page];

  // Auth split layout
  await page.goto(BASE + '/register');
  await page.getByText('موظف مبيعات ذكي يعمل بجانب فريقك').waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/ux-01-register-desktop.png` });
  await page.fill('#companyName', 'شركة التجربة');
  await page.fill('#fullName', 'نورة المديرة');
  await page.fill('#email', 'ux@e2e.sa');
  await page.fill('#password', 'correct-horse-battery');
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.waitForURL('**/home');
  log('registered');

  // Keyboard: on a fresh page load, the first Tab reveals the skip link
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'تخطَّ إلى المحتوى' });
  assert(await skip.evaluate((el) => el === document.activeElement), 'skip link is not first in tab order');
  await page.waitForTimeout(300); // focus transition
  const box = await skip.boundingBox();
  assert(box && box.y >= 0, 'skip link not visible on focus');
  log('skip link focusable and visible');

  // Create an account, then delete through the styled confirm dialog
  await page.getByRole('navigation').getByRole('link', { name: 'العملاء', exact: true }).click();
  await page.getByRole('button', { name: 'عميل جديد' }).first().click();
  await page.fill('#acc-name', 'عميل للتجربة');
  await page.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
  await page.getByRole('heading', { name: 'عميل للتجربة' }).waitFor();
  await page.getByRole('button', { name: 'حذف' }).click();
  const confirmDialog = page.getByRole('dialog', { name: 'هل أنت متأكد؟' });
  await confirmDialog.waitFor();
  const focusedLabel = await page.evaluate(() => document.activeElement?.textContent?.trim());
  assert(focusedLabel === 'إلغاء', `destructive dialog should focus Cancel, got "${focusedLabel}"`);
  await page.screenshot({ path: `${OUT}/ux-02-confirm-dialog.png` });
  await page.keyboard.press('Escape');
  await confirmDialog.waitFor({ state: 'hidden' });
  assert(page.url().includes('/accounts/'), 'Escape must cancel without deleting');
  log('confirm dialog: focus on Cancel, Escape cancels');
  await page.getByRole('button', { name: 'حذف' }).click();
  await confirmDialog.getByRole('button', { name: 'حذف' }).click();
  await page.waitForURL('**/accounts');
  log('confirm dialog: confirm deletes');

  // Toast on save
  await page.getByRole('navigation').getByRole('link', { name: 'إعدادات الشركة' }).click();
  await page.getByRole('button', { name: 'حفظ' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'تم الحفظ بنجاح' });
  await toast.waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/ux-03-toast.png` });
  await toast.waitFor({ state: 'hidden', timeout: 6000 });
  log('toast shown and auto-dismissed');

  // Dark theme
  await page.getByRole('navigation').getByRole('link', { name: 'لوحة القياس' }).click();
  await page.getByRole('radio', { name: 'داكن' }).click();
  assert((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'theme attribute not set');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert(bg === 'rgb(17, 19, 18)', `dark page background expected rgb(17, 19, 18), got ${bg}`);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/ux-04-dashboard-dark.png`, fullPage: true });
  await page.reload();
  assert((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'theme not persisted across reload');
  log('dark theme applied and persisted');
  await page.getByRole('radio', { name: 'فاتح' }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/ux-05-dashboard-light.png`, fullPage: true });

  // Phone: bottom navigation + drawer
  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  watch(p2);
  globalThis.__pages.push(p2);
  await p2.goto(BASE + '/home');
  const bottomNav = p2.getByRole('navigation', { name: 'القائمة الرئيسية' });
  await bottomNav.getByRole('link', { name: 'المهام' }).click();
  await p2.waitForURL('**/tasks');
  await p2.waitForTimeout(400);
  await p2.screenshot({ path: `${OUT}/ux-06-tasks-phone.png` });
  await p2.getByRole('button', { name: 'المزيد' }).click();
  await p2.locator('#mobile-drawer').waitFor();
  await p2.waitForTimeout(400);
  await p2.screenshot({ path: `${OUT}/ux-07-drawer-phone.png` });
  await p2.keyboard.press('Escape');
  await p2.locator('#mobile-drawer').waitFor({ state: 'detached' });
  log('phone bottom nav + drawer (Escape closes)');
  for (const route of ['/home', '/dashboard', '/accounts', '/pipeline', '/visits', '/tasks', '/settings/crm']) {
    await p2.goto(BASE + route);
    await p2.waitForLoadState('networkidle');
    const overflow = await p2.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert(!overflow, `horizontal overflow on ${route}`);
    const small = await p2.evaluate(() =>
      [...document.querySelectorAll('main a, main button, nav a, nav button')]
        .filter((el) => el.offsetParent !== null && el.getAttribute('aria-hidden') !== 'true')
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && (r.height < 36 || r.width < 36))
        .map(({ el, r }) => `${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20)} ${Math.round(r.width)}x${Math.round(r.height)}`),
    );
    if (small.length) log(`  note ${route}: targets under 36px: ${small.slice(0, 4).join(' | ')}`);
  }
  log('375px: no horizontal overflow on 7 screens');

  // Reduced motion: transitions collapse to ~0
  const rm = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', storageState: await ctx.storageState() });
  const p3 = await rm.newPage();
  watch(p3);
  await p3.goto(BASE + '/home');
  const dur = await p3.locator('main > div').first().evaluate((el) => getComputedStyle(el).animationDuration);
  assert(dur === '1e-05s' || dur === '0.01ms' || parseFloat(dur) < 0.001, `reduced motion not honoured (animation-duration ${dur})`);
  log(`reduced motion honoured (page animation-duration ${dur})`);

  const relevant = errors.filter((e) => !/status of 40[134]/.test(e));
  log('console errors:', relevant.length ? relevant : 'none');
  await browser.close();
  if (relevant.length) process.exit(1);
  console.log('UX E2E PASSED');
})().catch(async (e) => {
  console.error('UX E2E FAILED:', e.message);
  for (const [i, pg] of (globalThis.__pages ?? []).entries()) await pg.screenshot({ path: `${OUT}/failure-ux-${i}.png`, fullPage: true }).catch(() => {});
  process.exit(1);
});
