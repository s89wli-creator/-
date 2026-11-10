/**
 * Foundation end-to-end flow in a real browser (Arabic RTL, phone + desktop):
 * register -> territory -> invite -> accept on phone -> RBAC -> assign -> settings -> audit -> EN toggle -> logout.
 * Requires the API (MAIL_TRANSPORT=log, output in E2E_MAIL_LOG) and the web app running, on an empty database.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.env.E2E_OUT ?? require('path').join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const MAIL_LOG = process.env.E2E_MAIL_LOG ?? '/tmp/api-e2e.log';
const log = (...a) => console.log('•', ...a);

async function checkPage(page, name) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  const dir = await page.evaluate(() => document.documentElement.dir);
  log(`${name}: dir=${dir} horizontalOverflow=${overflow}`);
  if (overflow) throw new Error(`horizontal overflow on ${name}`);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p) => {
    p.on('console', (m) => m.type() === 'error' && errors.push(`${p.url()} :: ${m.text()}`));
    p.on('pageerror', (e) => errors.push(`${p.url()} :: ${e.message}`));
  };

  // ---- Owner on desktop
  const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const owner = await ownerCtx.newPage(); watch(owner);
  await owner.goto(BASE + '/register');
  await checkPage(owner, 'register');
  await owner.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await owner.getByText('هذا الحقل مطلوب.').first().waitFor();
  log('client validation shows Arabic errors');
  await owner.fill('#companyName', 'شركة انجزني التجريبية');
  await owner.fill('#fullName', 'عبدالله المالك');
  await owner.fill('#email', 'owner@e2e.sa');
  await owner.fill('#password', 'correct-horse-battery');
  await owner.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await owner.waitForURL('**/home');
  await owner.getByRole('heading', { name: 'مرحباً عبدالله المالك' }).waitFor();
  await owner.screenshot({ path: `${OUT}/01-home-owner-desktop.png` });
  log('registered and landed on /home');

  // Territories
  await owner.getByRole('navigation').getByRole('link', { name: 'المناطق' }).click();
  await owner.getByRole('button', { name: 'منطقة جديدة' }).click();
  await owner.fill('#tr-name', 'المنطقة الوسطى');
  await owner.getByLabel('الرياض').check();
  await owner.getByLabel('القصيم').check();
  await owner.fill('#tr-cities', 'الرياض، بريدة');
  await owner.getByRole('button', { name: 'حفظ' }).click();
  await owner.getByRole('heading', { name: 'المنطقة الوسطى' }).waitFor();
  log('territory created');

  // Invite a rep
  await owner.getByRole('navigation').getByRole('link', { name: 'فريق العمل' }).click();
  await owner.getByRole('button', { name: 'دعوة عضو' }).click();
  await owner.fill('#invite-email', 'rep@e2e.sa');
  await owner.selectOption('#invite-role', 'rep');
  await owner.fill('#invite-title', 'مندوب الرياض');
  await owner.getByRole('dialog').getByRole('button', { name: 'دعوة عضو' }).click();
  await owner.getByText('تم إرسال الدعوة إلى rep@e2e.sa').waitFor();
  await owner.screenshot({ path: `${OUT}/02-team-owner-desktop.png` });
  log('invitation sent');

  // Read invitation link from API mail log (dev "log" transport)
  await new Promise((r) => setTimeout(r, 500));
  const apiLog = fs.readFileSync(MAIL_LOG, 'utf8');
  const link = [...apiLog.matchAll(/http:\/\/localhost:3000\/invite\/([A-Za-z0-9_\-%]+)/g)].pop()[0];

  // ---- Rep on phone (360px)
  const repCtx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const rep = await repCtx.newPage(); watch(rep);
  await rep.goto(link);
  await rep.getByText('تمت دعوتك للانضمام إلى شركة انجزني التجريبية بصفة مندوب مبيعات.').waitFor();
  await checkPage(rep, 'invite (360px)');
  await rep.screenshot({ path: `${OUT}/03-invite-rep-mobile.png`, fullPage: true });
  await rep.fill('#fullName', 'سعد المندوب');
  await rep.fill('#password', 'rep-strong-passphrase');
  await rep.getByRole('button', { name: 'قبول الدعوة' }).click();
  await rep.waitForURL('**/home');
  await rep.getByText('دورك في شركة انجزني التجريبية: مندوب مبيعات').waitFor();
  await checkPage(rep, 'home rep (360px)');
  await rep.getByRole('button', { name: 'القائمة الرئيسية' }).click();
  await rep.locator('#mobile-drawer nav').waitFor();
  const repNav = (await rep.locator('#mobile-drawer nav a').allInnerTexts()).map((x) => x.trim());
  log('rep navigation:', JSON.stringify(repNav));
  if (repNav.includes('فريق العمل') || repNav.includes('سجل التدقيق')) throw new Error('rep sees admin navigation');
  await rep.screenshot({ path: `${OUT}/04-home-rep-mobile.png`, fullPage: true });
  await rep.goto(BASE + '/team');
  await rep.getByText('ليست لديك صلاحية لعرض هذه الصفحة.').waitFor();
  log('rep blocked from /team');

  // ---- Owner: rep visible, assign to territory, company settings, audit
  await owner.reload();
  await owner.getByText('سعد المندوب').waitFor();
  await owner.getByRole('navigation').getByRole('link', { name: 'المناطق' }).click();
  await owner.getByRole('button', { name: 'تعديل' }).click();
  await owner.getByRole('dialog').getByLabel('سعد المندوب').check();
  await owner.getByRole('button', { name: 'حفظ' }).click();
  await owner.getByText('المندوبون المسندون: سعد المندوب').waitFor();
  await owner.screenshot({ path: `${OUT}/05-territories-desktop.png` });
  log('rep assigned to territory');

  await owner.getByRole('navigation').getByRole('link', { name: 'إعدادات الشركة' }).click();
  await owner.fill('#crNumber', '123');
  await owner.getByRole('button', { name: 'حفظ' }).click();
  await owner.getByText('رقم السجل التجاري 10 أرقام.').waitFor();
  await owner.fill('#crNumber', '1010123456');
  await owner.fill('#vatNumber', '300000000000003');
  await owner.getByRole('button', { name: 'حفظ' }).click();
  await owner.getByText('تم الحفظ').waitFor();
  log('company settings validated + saved');

  await owner.getByRole('navigation').getByRole('link', { name: 'سجل التدقيق' }).click();
  await owner.getByRole('list').getByText('تعديل إعدادات الشركة').waitFor();
  await owner.getByRole('list').getByText('قبول دعوة').waitFor();
  await owner.screenshot({ path: `${OUT}/06-audit-desktop.png` });
  log('audit log shows actions');

  // Owner on phone: team page layout
  const ownerPhone = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, storageState: await ownerCtx.storageState() });
  const op = await ownerPhone.newPage(); watch(op);
  for (const path of ['/team', '/team/territories', '/settings/company', '/settings/audit']) {
    await op.goto(BASE + path);
    await op.waitForLoadState('networkidle');
    await checkPage(op, `${path} (360px)`);
  }
  await op.goto(BASE + '/team'); await op.waitForLoadState('networkidle');
  await op.screenshot({ path: `${OUT}/07-team-owner-mobile.png`, fullPage: true });

  // English toggle
  await owner.goto(BASE + '/home');
  await owner.getByRole('button', { name: 'English' }).click();
  await owner.getByRole('heading', { name: 'Welcome, عبدالله المالك' }).waitFor();
  const dir = await owner.evaluate(() => document.documentElement.dir);
  log('english toggle dir =', dir);
  if (dir !== 'ltr') throw new Error('dir not switched');
  await owner.screenshot({ path: `${OUT}/08-home-owner-en.png` });

  // Logout
  await owner.getByRole('button', { name: 'Sign out' }).click();
  await owner.waitForURL('**/login');
  log('logout ok');

  // Login wrong password -> translated error
  await owner.fill('#email', 'owner@e2e.sa');
  await owner.fill('#password', 'wrong-password-123');
  await owner.getByRole('button', { name: 'Sign in' }).last().click();
  await owner.getByText('Email or password is incorrect.').waitFor();
  log('login error translated');

  const relevant = errors.filter((e) => !/status of 40[13]/.test(e));
  log('console errors:', relevant.length ? relevant : 'none', `(expected 401/403 network logs filtered: ${errors.length - relevant.length})`);
  await browser.close();
  if (relevant.length) process.exit(1);
  console.log('E2E PASSED');
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
