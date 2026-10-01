import { api, $ } from './util.js';
import { landing } from './views/landing.js';
import { composer } from './views/new.js';
import { poolView } from './views/pool.js';
import { consoleView } from './views/console.js';

const app = $('#app');
let cleanup = null;
let cfg = { paypalMode: 'simulated' };
const cfgReady = api('/config').then((c) => { cfg = c; const pill = $('#mode-pill'); pill.textContent = c.paypalMode === 'sandbox' ? 'PayPal sandbox' : 'Sandbox simulation'; }).catch(() => {});

function nav(path, replace) {
  if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState']({}, '', path);
  route();
}

async function route() {
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  scrollTo({ top: 0 });
  const p = location.pathname;
  await cfgReady;
  if (p === '/' || p === '') cleanup = landing(app, nav);
  else if (p === '/new') cleanup = composer(app, nav);
  else if (p === '/console') cleanup = consoleView(app, nav);
  else if (p.startsWith('/p/')) cleanup = poolView(app, nav, p.slice(3), cfg);
  else app.innerHTML = '<div class="wrap"><div class="empty">Nothing here. <a href="/" data-link>Home</a></div></div>';
  document.title = { '/': 'Otu — buy as one', '/new': 'New pool · Otu', '/console': 'Console · Otu' }[p] || 'Pool · Otu';
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault(); nav(a.getAttribute('href'));
});
addEventListener('popstate', route);
addEventListener('scroll', () => $('.nav').classList.toggle('scrolled', scrollY > 8), { passive: true });
route();
