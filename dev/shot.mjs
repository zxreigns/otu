// QA screenshots: node dev/shot.mjs <baseUrl> <outDir>
// Walks the whole money loop on a fresh demo pool and captures each beat.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const base = process.argv[2] || 'http://localhost:8790';
const out = process.argv[3] || '/tmp/otu-shots';
const exe = process.env.CHROME_BIN;
const fs = await import('node:fs'); fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const errors = [];
async function page(w, h, mobile) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: !!mobile, hasTouch: !!mobile });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return p;
}
const d = await page(1440, 900);
await d.goto(base + '/', { waitUntil: 'networkidle' }); await d.waitForTimeout(3200);
await d.screenshot({ path: `${out}/01_landing.png` });
await d.screenshot({ path: `${out}/01b_landing_full.png`, fullPage: true });
await d.goto(base + '/new', { waitUntil: 'networkidle' });
await d.click('[data-ex="0"]'); await d.click('#go');
await d.waitForSelector('#open', { timeout: 40000 }); await d.waitForTimeout(400);
await d.click('#fill-n');
await d.screenshot({ path: `${out}/02_draft.png`, fullPage: true });
await d.click('#open');
await d.waitForURL(/\/p\//, { timeout: 20000 }); await d.waitForTimeout(800);
await d.screenshot({ path: `${out}/03_pool_open.png` });
await d.click('#tick'); await d.waitForTimeout(1500);
await d.screenshot({ path: `${out}/04_reminded.png` });
await d.click('[data-crowd]');
await d.waitForSelector('.sheet', { timeout: 60000 }); await d.waitForTimeout(700);
await d.screenshot({ path: `${out}/05_approval.png` });
await d.click('.sheet [data-approve]');
await d.waitForSelector('.status.settled', { timeout: 40000 }); await d.waitForTimeout(800);
await d.screenshot({ path: `${out}/06_settled.png`, fullPage: true });
await d.goto(base + '/console', { waitUntil: 'networkidle' }); await d.waitForTimeout(2500);
await d.screenshot({ path: `${out}/07_console_members.png` });
await d.click('#tabs [data-t="ledger"]'); await d.waitForTimeout(800);
await d.screenshot({ path: `${out}/08_console_ledger.png` });
await d.click('#tabs [data-t="checks"]'); await d.waitForTimeout(800);
await d.screenshot({ path: `${out}/09_console_checks.png` });
await d.click('#tabs [data-t="events"]'); await d.waitForTimeout(800);
await d.screenshot({ path: `${out}/09b_console_webhooks.png` });
// Stability: the PayPal button must survive polling and other members paying.
const st = await (await fetch(base + '/api/demo/fresh', { method: 'POST' })).json();
await d.goto(base + '/p/' + st.id, { waitUntil: 'networkidle' });
await d.waitForSelector('paypal-button:not([hidden])', { timeout: 30000 }).catch(() => errors.push('paypal-button never appeared'));
await d.evaluate(() => { window.__btn = document.querySelector('paypal-button'); window.__muts = 0; new MutationObserver((l) => (window.__muts += l.length)).observe(document.querySelector('#r-pay'), { childList: true, subtree: true }); });
const others = st.members.filter((x) => !x.paidAt).slice(1, 3);
for (const o of others) { await fetch(`${base}/api/pools/${st.id}/members/${o.id}/demo-pay`, { method: 'POST' }); await d.waitForTimeout(3000); }
await d.waitForTimeout(3000);
const stable = await d.evaluate(() => ({ same: document.querySelector('paypal-button') === window.__btn && window.__btn.isConnected, payPanelMutations: window.__muts }));
console.error('STABILITY', JSON.stringify(stable));
await d.screenshot({ path: `${out}/12_pool_paypal_v6.png` });
const m = await page(390, 844, true);
await m.goto(base + '/', { waitUntil: 'networkidle' }); await m.waitForTimeout(2500);
await m.screenshot({ path: `${out}/10_mobile_landing.png` });
const fresh = await (await fetch(base + '/api/demo/fresh', { method: 'POST' })).json();
await m.goto(base + '/p/' + fresh.id, { waitUntil: 'networkidle' }); await m.waitForTimeout(1000);
await m.waitForTimeout(2500);
await m.screenshot({ path: `${out}/11_mobile_pool.png`, fullPage: true });
await m.screenshot({ path: `${out}/11b_mobile_pool_top.png` });
await browser.close();
console.log(JSON.stringify({ ok: true, errors }, null, 1));
