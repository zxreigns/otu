export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (c) => '$' + (Math.round(c || 0) / 100).toFixed(2);
export const initials = (n) => String(n).split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
export const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + 'm ago'; if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago'; };
export const until = (iso) => { if (!iso) return 'no deadline'; const s = (Date.parse(iso) - Date.now()) / 1000; if (s <= 0) return 'closed'; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h left` : h ? `${h}h ${m}m left` : `${m}m left`; };

export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.pool) throw Object.assign(new Error(j.error || `request failed (${r.status})`), { data: j, status: r.status });
  return j;
}

let toastT;
export function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
}

export function observeReveal(root = document) {
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.15 });
  $$('.reveal', root).forEach((el, i) => { el.style.transitionDelay = (el.dataset.delay || 0) + 'ms'; io.observe(el); });
}

export const STATUS_LABEL = { collecting: 'Collecting', filled: 'Filled', awaiting_approval: 'Needs your OK', purchased: 'Bought', settled: 'Settled', failed: 'Cancelled', refunded: 'Refunded' };
