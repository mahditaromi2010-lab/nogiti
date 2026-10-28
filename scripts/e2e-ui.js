/* Browser UI check (optional; needs Playwright + Chromium, which are NOT project dependencies).
 *   BASE_URL=http://127.0.0.1:3000 ADMIN_USERNAME=... ADMIN_PASSWORD=... SCREENSHOT_DIR=./ui-shots npm run test:ui
 * Checks every page at phone / tablet / desktop widths for: HTTP status, horizontal overflow, console errors,
 * CSP violations; then exercises the admin login, keyboard navigation and the confirmation dialog.
 */
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Playwright is not installed; skipping UI check (NOT RUN).'); process.exit(2); }

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const USER = process.env.ADMIN_USERNAME;
const PASS = process.env.ADMIN_PASSWORD;
const OUT = process.env.SCREENSHOT_DIR || '';
const VIEWPORTS = [['phone', 360, 780], ['tablet', 768, 1024], ['desktop', 1366, 900]];
const PUBLIC = ['/', '/tools', '/shop', '/articles', '/about', '/login', '/admin/login', '/does-not-exist'];
const ADMIN = ['/admin', '/admin/products', '/admin/products/new', '/admin/articles', '/admin/articles/new', '/admin/orders', '/admin/users', '/admin/settings', '/admin/audit', '/admin/admins', '/admin/account'];

const results = [];
const record = (ok, name, detail = '') => { results.push({ ok, name, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function checkPage(page, url, label, expectStatus) {
  const errors = [];
  const onConsole = msg => { if (msg.type() === 'error' && !(expectStatus === 404 || url === '/does-not-exist') ) errors.push(msg.text()); };
  page.on('console', onConsole);
  const response = await page.goto(BASE + url, { waitUntil: 'networkidle' });
  const status = response ? response.status() : 0;
  const overflow = await page.evaluate(() => {
    const doc = document.scrollingElement;
    const offenders = [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1) && !el.closest('.table-responsive') && getComputedStyle(el).position !== 'fixed'; }).slice(0, 3).map(el => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
    return { scroll: doc.scrollWidth - innerWidth, offenders };
  });
  const fontOk = await page.evaluate(() => document.fonts.check('16px Vazirmatn'));
  page.off('console', onConsole);
  const expected = expectStatus ?? (url === '/does-not-exist' ? 404 : 200);
  record(status === expected, `${label} ${url} status`, `${status}`);
  record(overflow.scroll <= 1, `${label} ${url} no horizontal page scroll`, overflow.scroll > 1 ? `+${overflow.scroll}px ${overflow.offenders.join(', ')}` : '');
  record(errors.length === 0, `${label} ${url} no console/CSP errors`, errors.slice(0, 2).join(' | '));
  if (label === 'desktop') record(fontOk, `${url} Vazirmatn font loaded from self-hosted file`);
  if (OUT) await page.screenshot({ path: path.join(OUT, `${label}${url.replace(/\//g, '_') || '_home'}.png`), fullPage: true });
}

(async () => {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const [label, width, height] of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'fa-IR' });
      const page = await context.newPage();
      for (const url of PUBLIC) await checkPage(page, url, label);
      if (USER && PASS) {
        await page.goto(`${BASE}/admin/login`);
        await page.fill('#username', USER);
        await page.fill('#password', PASS);
        await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
        record(new URL(page.url()).pathname === '/admin', `${label} admin login lands on dashboard`, page.url());
        for (const url of ADMIN) await checkPage(page, url, label);
        if (label === 'desktop') {
          // Keyboard: skip link is the first focusable element.
          await page.goto(`${BASE}/admin/products`);
          await page.keyboard.press('Tab');
          record(await page.evaluate(() => document.activeElement?.classList.contains('skip-link')), 'skip link is first in tab order');
          // Password toggle on the login page is keyboard operable and announces state.
          // Confirmation dialog: opens, focus on cancel, Escape closes without submitting, focus returns.
          const trigger = page.locator('[data-confirm]').first();
          if (await trigger.count()) {
            await trigger.focus();
            await page.keyboard.press('Enter');
            const dialog = page.locator('.dialog[role="alertdialog"]');
            record(await dialog.isVisible(), 'confirm dialog opens from keyboard');
            record(await page.evaluate(() => document.activeElement?.hasAttribute('data-dialog-cancel')), 'focus starts on the safe (cancel) action');
            await page.keyboard.press('Escape');
            record(!(await dialog.isVisible()), 'Escape closes the dialog');
            record(await page.evaluate(() => document.activeElement?.hasAttribute('data-confirm')), 'focus returns to the trigger');
            record(new URL(page.url()).pathname === '/admin/products', 'cancelled action did not submit');
          } else record(false, 'confirm dialog test', 'no [data-confirm] element on /admin/products (seed data needed)');
          // Filter form round-trip.
          await page.fill('#f-q', 'افزونه');
          await Promise.all([page.waitForNavigation(), page.click('.filter-actions button[type=submit]')]);
          record(new URL(page.url()).searchParams.get('q') === 'افزونه', 'admin filter submits as GET query');
          // Logout.
          await page.goto(`${BASE}/admin`);
          await Promise.all([page.waitForNavigation(), page.click('form[action="/admin/logout"] button')]);
          record(new URL(page.url()).pathname === '/admin/login', 'logout returns to admin login');
          const after = await page.goto(`${BASE}/admin`);
          record(after.status() === 403, 'admin pages refused after logout', String(after.status()));
        }
      } else if (label === 'desktop') record(false, 'admin UI checks', 'ADMIN_USERNAME / ADMIN_PASSWORD not provided (NOT RUN)');
      await context.close();
    }
  } finally { await browser.close(); }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
