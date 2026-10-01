import { api, esc, money, initials, ago, until, toast, STATUS_LABEL, $ } from '../util.js';

// Pool page. Rendered once as a shell, then patched region by region: polling
// only touches the regions whose HTML actually changed, member rows and feed
// items are keyed, and the pay panel (with the PayPal button) is rebuilt only
// when who is paying changes — never while a PayPal window is open.

// ---- PayPal JS SDK v6 (web components + payment sessions) -----------------
let sdkPromise = null;
function paypalSdk(cfg) {
  if (!sdkPromise) sdkPromise = (async () => {
    await new Promise((res, rej) => {
      if (window.paypal?.createInstance) return res();
      const s = document.createElement('script');
      s.src = 'https://www.sandbox.paypal.com/web-sdk/v6/core'; s.async = true;
      s.onload = res; s.onerror = () => rej(new Error('PayPal SDK failed to load'));
      document.head.appendChild(s);
    });
    let auth;
    try { const t = await api('/paypal/client-token'); auth = { clientToken: t.token }; } catch { auth = { clientId: cfg.paypalClientId }; }
    const sdk = await window.paypal.createInstance({ ...auth, components: ['paypal-payments'], pageType: 'checkout', locale: 'en-US' });
    const methods = await sdk.findEligibleMethods({ currencyCode: 'USD' }).catch(() => null);
    return { sdk, eligible: !methods || methods.isEligible('paypal') };
  })().catch((e) => { sdkPromise = null; throw e; });
  return sdkPromise;
}

// ---- small motion helpers --------------------------------------------------
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
function patch(el, html) { if (el && el._h !== html) { el._h = html; el.innerHTML = html; return true; } return false; }
function countTo(el, cents) {
  if (!el) return;
  const from = el._v ?? cents; el._v = cents;
  if (reduce || from === cents) { el.textContent = money(cents); return; }
  const t0 = performance.now(), d = 900;
  const step = (t) => { const k = Math.min(1, (t - t0) / d), e = 1 - Math.pow(1 - k, 3); el.textContent = money(Math.round(from + (cents - from) * e)); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
  el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
}

// ---- the money map: members -> pool -> supplier, and back ------------------
const FLOW_SVG = `
<svg viewBox="0 0 640 210" class="flow-svg" aria-hidden="true">
  <defs><linearGradient id="fg" x1="0" x2="1"><stop offset="0" stop-color="#121212" stop-opacity=".08"/><stop offset="1" stop-color="#121212" stop-opacity=".22"/></linearGradient></defs>
  <path id="f-in" d="M118 92 C 200 92, 230 92, 282 92" class="lane"/>
  <path id="f-buy" d="M358 92 C 410 92, 440 92, 522 92" class="lane"/>
  <path id="f-back" d="M320 128 C 300 196, 120 196, 80 130" class="lane back"/>
  <g class="node" transform="translate(80 92)"><circle r="38"/><text y="-2" class="n-big" data-n="members">0</text><text y="16" class="n-small">members</text></g>
  <g class="node pool" transform="translate(320 92)"><circle r="40"/><text y="6" class="n-mark">Otu</text></g>
  <g class="node" transform="translate(560 92)"><circle r="38"/><text y="-2" class="n-big">◆</text><text y="16" class="n-small">supplier</text></g>
  <text x="200" y="76" class="lab" data-l="in">$0.00</text><text x="200" y="116" class="cap">pay-ins</text>
  <text x="440" y="76" class="lab" data-l="buy">$0.00</text><text x="440" y="116" class="cap">purchase</text>
  <text x="200" y="206" class="lab green" data-l="back">$0.00</text><text x="200" y="166" class="cap green">paid back</text>
  <g class="dots"></g>
</svg>`;

function flyDots(svg, pathId, n, cls) {
  if (reduce || !svg) return;
  const path = svg.querySelector('#' + pathId), g = svg.querySelector('.dots');
  const len = path.getTotalLength();
  for (let i = 0; i < n; i++) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', 4.5); c.setAttribute('class', 'dot ' + cls); g.appendChild(c);
    const t0 = performance.now() + i * 140, d = 1100;
    const step = (t) => {
      const k = (t - t0) / d;
      if (k < 0) { c.style.opacity = 0; return requestAnimationFrame(step); }
      if (k >= 1) { c.remove(); svg.querySelector(`#${pathId}`).classList.add('hot'); setTimeout(() => path.classList.remove('hot'), 500); return; }
      const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const pt = path.getPointAtLength(len * e);
      c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y); c.style.opacity = Math.sin(Math.PI * k) * .95 + .05;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

export function poolView(app, nav, id, cfg) {
  let pool = null, poll = null, lastRev = -1, selected = null, crowdRunning = false, ppBusy = false, payKey = null, alive = true;
  const seenLedger = new Set(), seenPaid = new Set();
  let first = true;

  app.innerHTML = `<div class="wrap"><div class="empty">Loading pool…</div></div>`;

  function shell() {
    app.innerHTML = `
    <div class="wrap">
      <div class="pool-head" id="r-head"></div>
      <div class="pool">
        <div class="stack">
          <div class="card rise" style="--i:0">
            <div class="fill">
              <div class="ring" id="ring"><div><div><b id="r-count">0/0</b><br><span>households in</span></div></div></div>
              <div class="kpis">
                <div class="kpi"><small>Held</small><b data-k="held">$0.00</b></div>
                <div class="kpi"><small>Spent</small><b data-k="spent">$0.00</b></div>
                <div class="kpi green"><small>Paid back</small><b data-k="back">$0.00</b></div>
              </div>
            </div>
            <div class="flow" id="r-flow">${FLOW_SVG}</div>
          </div>
          <div id="r-offer"></div>
          <div id="r-action"></div>
          <div class="card rise" style="--i:2">
            <div class="row-between" style="margin-bottom:6px" id="r-mhead"></div>
            <ul class="members" id="r-members"></ul>
            <div id="r-pay"></div>
          </div>
          <div class="card flat rise" style="--i:3" id="r-mandate"></div>
          <p class="muted" style="font-size:14px" id="r-req"></p>
        </div>
        <aside class="card agent rise" style="--i:1">
          <div class="head"><span class="pulse"></span><b>Agent</b><span class="muted" style="font-size:13px;margin-left:auto" id="r-steps"></span></div>
          <div class="hookbar" id="r-hooks"></div>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button class="btn primary small" id="tick">Run the agent</button>
            <a class="btn ghost small" href="/console" data-link>Console</a>
          </div>
          <ul class="feed" id="r-feed"></ul>
        </aside>
      </div>
    </div>
    <div id="r-sheet"></div>`;
  }

  async function load() {
    if (!alive) return;
    try {
      const p = await api('/pools/' + id);
      if (p.rev !== lastRev) { pool = p; lastRev = p.rev; render(); }
    } catch (e) { if (!pool) { app.innerHTML = `<div class="wrap"><div class="empty">${esc(e.message)}. <a href="/" data-link>Back home</a></div></div>`; stop(); } }
  }
  const stop = () => { alive = false; clearInterval(poll); clearInterval(clock); if (app.onclick === onClick) app.onclick = null; };
  poll = setInterval(load, 2500);
  const clock = setInterval(() => app.querySelectorAll('[data-ago]').forEach((el) => { const t = ago(el.dataset.ago); if (el.textContent !== t) el.textContent = t; }), 15000);
  load();

  async function act(path, body, label) {
    try {
      const r = await api(`/pools/${id}${path}`, { method: 'POST', body: body || {} });
      if (r.pool && r.pool.rev !== lastRev) { pool = r.pool; lastRev = pool.rev; render(); }
      if (r.result?.ok === false) toast(r.result.error || blockedText(r.result.verdict) || 'The mandate said no.');
      else if (label) toast(label);
      return r;
    } catch (e) { toast(e.message); }
  }
  const blockedText = (v) => v && 'Blocked: ' + v.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ');

  function render() {
    if (first) shell();
    const p = pool, s = p.summary, chosen = p.offers.find((o) => o.id === p.chosenOfferId);
    const unpaid = p.members.filter((m) => !m.paidAt);
    if (!selected || !unpaid.find((m) => m.id === selected)) selected = unpaid[0]?.id || null;
    const sel = p.members.find((m) => m.id === selected);
    const back = p.ledger.filter((l) => l.type === 'refund' || l.type === 'payout').reduce((a, l) => a + l.amountCents, 0);
    const inSum = p.ledger.filter((l) => l.type === 'pay_in').reduce((a, l) => a + l.amountCents, 0);

    patch($('#r-head'), `<div><p class="eyebrow">${esc(p.organiser?.name || 'Organiser')}'s pool · ${esc(until(p.mandate.deadline))}</p><h2 style="margin-top:10px">${esc(p.title)}</h2></div>
        <span class="status ${p.status}">${STATUS_LABEL[p.status] || p.status}</span>`);

    // fill ring + KPIs animate in place
    $('#ring').style.setProperty('--p', s.fillPct);
    $('#r-count').textContent = `${s.paid}/${s.target}`;
    countTo(app.querySelector('[data-k=held]'), s.balanceCents);
    countTo(app.querySelector('[data-k=spent]'), s.spentCents);
    countTo(app.querySelector('[data-k=back]'), back);

    // money map
    const svg = $('#r-flow svg');
    svg.querySelector('[data-n=members]').textContent = p.members.length;
    svg.querySelector('[data-l=in]').textContent = money(inSum);
    svg.querySelector('[data-l=buy]').textContent = money(s.spentCents);
    svg.querySelector('[data-l=back]').textContent = money(back);
    svg.classList.toggle('has-buy', s.spentCents > 0); svg.classList.toggle('has-back', back > 0); svg.classList.toggle('has-in', inSum > 0);
    const fresh = p.ledger.filter((l) => !seenLedger.has(l.id));
    fresh.forEach((l) => seenLedger.add(l.id));
    if (!first) {
      const n = (t) => fresh.filter((l) => t.includes(l.type)).length;
      if (n(['pay_in'])) flyDots(svg, 'f-in', Math.min(6, n(['pay_in']) * 2), 'ink');
      if (n(['purchase'])) setTimeout(() => flyDots(svg, 'f-buy', 5, 'red'), 300);
      if (n(['refund', 'payout'])) setTimeout(() => flyDots(svg, 'f-back', Math.min(8, n(['refund', 'payout']) + 2), 'green'), 1100);
    }

    patch($('#r-offer'), chosen ? `<div class="card">
            <div class="offer"><span class="thumb" ${chosen.image ? `style="background-image:url('${esc(chosen.image)}')"` : ''}>${chosen.image ? '' : esc(chosen.merchant[0])}</span>
              <span class="meta"><b>${esc(chosen.title)}</b><small>${esc(chosen.merchant)} · ${chosen.quote.packs} pack${chosen.quote.packs > 1 ? 's' : ''} for ${s.target} households · ${esc(chosen.source === 'channel3' ? 'live via Channel3' : 'catalog price')}</small></span>
              <span class="save">−${chosen.quote.savingsPct}% vs alone</span></div>
            <div class="price-compare"><b>${money(chosen.quote.perHouseholdCents)}</b><span class="muted">a household, vs</span><s>${money(chosen.quote.aloneCents)}</s><span class="muted">buying alone</span></div>
          </div>` : '');

    patch($('#r-action'), (p.status === 'awaiting_approval' && p.pendingApproval ? approvalCard(p.pendingApproval) : '') + (p.status === 'settled' || p.status === 'refunded' ? settledCard(p) : ''));

    patch($('#r-mhead'), `<p class="eyebrow">Members · each pays ${money(p.members[0]?.shareCents)}</p>
      ${p.status === 'collecting' && unpaid.length ? `<button class="btn ghost small" data-crowd ${crowdRunning ? 'disabled' : ''}>${crowdRunning ? 'Paying…' : `Demo: pay the other ${unpaid.length}`}</button>` : ''}`);

    // keyed member rows
    const ul = $('#r-members');
    for (const m of p.members) {
      let li = ul.querySelector(`li[data-id="${m.id}"]`);
      if (!li) { li = document.createElement('li'); li.dataset.id = m.id; ul.appendChild(li); }
      patch(li, memberRow(m, p));
      li.classList.toggle('paid', !!m.paidAt);
      if (m.paidAt && !seenPaid.has(m.id)) { seenPaid.add(m.id); if (!first) { li.classList.remove('just'); void li.offsetWidth; li.classList.add('just'); } }
    }

    // pay panel: rebuilt only when the payer or the pool phase changes
    const key = p.status === 'collecting' && sel ? sel.id : 'none';
    if (key !== payKey && !ppBusy) { payKey = key; buildPay(p, sel, unpaid); }
    else if (sel) syncWho(unpaid, sel);

    patch($('#r-mandate'), `<p class="eyebrow" style="margin-bottom:8px">Mandate</p>${p.mandateText.map((t) => `<div style="font-size:14px;padding:3px 0">· ${esc(t)}</div>`).join('')}`);
    patch($('#r-req'), p.request ? `Started from: “${esc(p.request)}”` : '');

    // agent feed: newest first, keyed, new items slide in
    $('#r-steps').textContent = `${p.actions.length} step${p.actions.length === 1 ? '' : 's'}`;
    const tick = $('#tick'); tick.disabled = !['collecting', 'filled'].includes(p.status);
    const hooks = (p.webhooks || []).filter((w) => w.verified !== false);
    patch($('#r-hooks'), hooks.length ? `<span class="hookdot"></span>${hooks.length} PayPal webhook${hooks.length > 1 ? 's' : ''} verified · last: ${esc(hooks[hooks.length - 1].label || hooks[hooks.length - 1].type)}` : `<span class="hookdot idle"></span>Listening for PayPal webhooks`);
    const feed = $('#r-feed');
    for (const a of p.actions) {
      const ex = feed.querySelector(`li[data-id="${CSS.escape(a.id)}"]`);
      if (ex) { patch(ex, feedBody(a)); continue; }
      const li = document.createElement('li'); li.dataset.id = a.id; patch(li, feedBody(a));
      if (!first) li.classList.add('enter');
      feed.insertBefore(li, feed.firstChild);
    }

    const showSheet = p.status === 'awaiting_approval' && p.pendingApproval && !sessionStorage.getItem('dismiss:' + p.pendingApproval.id);
    patch($('#r-sheet'), showSheet ? sheet(p.pendingApproval, p) : '');
    first = false;
  }

  function buildPay(p, sel, unpaid) {
    const box = $('#r-pay');
    if (!sel) { box.innerHTML = ''; return; }
    const sandbox = cfg.paypalMode === 'sandbox';
    box.innerHTML = `<div class="paybox">
      <div class="row-between"><span>Pay as <b>${esc(sel.name)}</b> · <span class="mono">${money(sel.shareCents)}</span></span>
      <select id="who" aria-label="Pay as">${unpaid.map((m) => `<option value="${m.id}" ${m.id === sel.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
      ${sandbox ? `<div class="paypal-slot" id="pp-slot"><paypal-button type="pay" class="paypal-gold" hidden></paypal-button><div class="pp-skel" id="pp-skel"></div></div>
        <p class="muted paynote">PayPal sandbox · log in as the judge buyer from the README. No real money.</p>`
      : `<button class="btn primary" data-simpay style="width:100%;justify-content:center;margin-top:10px">Pay ${money(sel.shareCents)} (sandbox simulation)</button><p class="muted paynote">PayPal keys aren't configured on this deployment, so payments run through the built-in simulator.</p>`}
    </div>`;
    box.querySelector('#who').onchange = (e) => { selected = e.target.value; payKey = null; render(); };
    if (sandbox) mountPayPal(sel);
  }

  // keep the "pay as" picker current without touching the PayPal button
  function syncWho(unpaid, sel) {
    const w = $('#who'); if (!w) return;
    const html = unpaid.map((m) => `<option value="${m.id}" ${m.id === sel.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    if (w._h !== html && document.activeElement !== w) { w._h = html; w.innerHTML = html; }
  }

  async function mountPayPal(member) {
    const btn = $('#pp-slot paypal-button'), skel = $('#pp-skel');
    try {
      const { sdk, eligible } = await paypalSdk(cfg);
      if (!btn.isConnected) return;
      if (!eligible) throw new Error('PayPal is not available for this browser');
      const session = sdk.createPayPalOneTimePaymentSession({
        onApprove: async (data) => { ppBusy = false; payKey = null; await act(`/members/${member.id}/capture`, { orderId: data.orderId }, `${member.name} paid through PayPal`); },
        onCancel: () => { ppBusy = false; toast('Payment cancelled'); if (pool) { payKey = null; render(); } },
        onError: (err) => { ppBusy = false; toast('PayPal: ' + (err?.message || err)); },
      });
      btn.addEventListener('click', async () => {
        ppBusy = true;
        const order = api(`/pools/${id}/members/${member.id}/order`, { method: 'POST' }).then((r) => {
          if (!r.result?.orderId) throw new Error(blockedText(r.result?.verdict) || 'blocked');
          return { orderId: r.result.orderId };
        });
        try { await session.start({ presentationMode: 'auto' }, order); }
        catch (e) { ppBusy = false; toast('PayPal: ' + (e?.message || e)); }
      });
      btn.removeAttribute('hidden'); skel?.remove();
    } catch (e) { if (skel) skel.outerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  }

  async function crowd() {
    if (crowdRunning) return; crowdRunning = true; render();
    for (const m of pool.members.filter((x) => !x.paidAt)) {
      if (ppBusy) break;
      await act(`/members/${m.id}/demo-pay`);
      await new Promise((r) => setTimeout(r, 650));
      if (pool.status !== 'collecting') break;
    }
    crowdRunning = false;
    if (pool.status === 'filled') await act('/tick', {}, 'Pool filled. The agent is re-checking prices…');
    else render();
  }

  // one delegated click handler for every region
  const onClick = async (e) => {
    const t = e.target.closest('button,[data-approve],[data-decline],[data-later],[data-again],[data-crowd],[data-simpay]');
    if (!t || !pool) return;
    if (t.id === 'tick') return act('/tick', { force: true }, 'Agent ran');
    if (t.hasAttribute('data-crowd')) return crowd();
    if (t.hasAttribute('data-simpay')) return act(`/members/${selected}/demo-pay`, {}, 'Payment captured');
    if (t.hasAttribute('data-approve')) return act('/approve', { by: pool.organiser?.name || 'organiser' }, 'Approved. Buying and paying everyone back…');
    if (t.hasAttribute('data-decline')) return act('/decline', { by: pool.organiser?.name || 'organiser' }, 'Declined. Refunding everyone.');
    if (t.hasAttribute('data-later')) { sessionStorage.setItem('dismiss:' + pool.pendingApproval.id, 1); return render(); }
    if (t.hasAttribute('data-again')) { const j = await api('/demo/fresh', { method: 'POST' }); nav('/p/' + j.id); }
  };
  app.onclick = onClick;

  return stop;
}

function memberRow(m, p) {
  const payIn = p.ledger.find((l) => l.type === 'pay_in' && l.memberId === m.id);
  const hook = payIn?.paypal?.confirmedByWebhook ? '<span class="hook" title="Confirmed by a verified PayPal webhook">✓ PayPal</span>' : '';
  const state = m.backCents ? `<span class="tag back">+${money(m.backCents)} back</span>` : m.paidAt ? '<span class="tag paid">Paid</span>' : m.reminders?.length ? `<span class="tag reminded">Reminded ×${m.reminders.length}</span>` : '<span class="tag">Invited</span>';
  return `<span class="avatar">${esc(initials(m.name))}</span><span class="who"><b>${esc(m.name)} ${hook}</b><small>${m.paidAt ? 'paid ' + ago(m.paidAt) + (m.captureId ? ` · <span class="pp-id">${esc(m.captureId)}</span>` : '') : esc(m.email || '')}</small></span><span class="amt">${money(m.shareCents)}</span>${state}`;
}

function feedItem(a) {
  return `<li data-id="${esc(a.id)}">${feedBody(a)}</li>`;
}
function feedBody(a) {
  const checks = a.checks?.length ? `<details><summary>${a.checks.filter((c) => c.ok).length}/${a.checks.length} mandate checks</summary><ul class="checks">${a.checks.map((c) => `<li class="${c.ok ? '' : 'no'}"><span><b>${esc(c.rule)}</b> ${esc(c.detail)}</span></li>`).join('')}</ul></details>` : '';
  const mode = a.result?.mode ? ` · ${a.result.mode}` : '';
  return `<div class="t"><span>${esc(a.actor)} · ${esc(a.kind)}${esc(mode)}</span><span class="d ${a.decision}">${esc(a.decision.replace('_', ' '))}</span><span style="margin-left:auto" data-ago="${esc(a.at)}">${ago(a.at)}</span></div>${esc(a.summary)}${a.reasoning ? `<div class="why">${esc(a.reasoning)}</div>` : ''}${checks}`;
}

function approvalCard(ap) {
  return `<div class="card" style="box-shadow:0 0 0 2px var(--amber),var(--shadow)"><p class="eyebrow" style="color:var(--amber)">Needs your OK</p><h3 style="margin:8px 0">Buy ${ap.quote.packs} × ${esc(ap.title)} for ${money(ap.amountCents)}?</h3><p class="why" style="margin:0 0 14px">${esc(ap.rationale)}</p><div style="display:flex;gap:10px"><button class="btn red" data-approve>Approve purchase</button><button class="btn ghost" data-decline>Decline and refund all</button></div></div>`;
}

function sheet(ap, p) {
  const fails = ap.checks.filter((c) => !c.ok).length;
  return `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="Approve purchase">
    <p class="eyebrow">Pool filled · ${ap.households} households · ${money(ap.balanceCents)} held</p>
    <h3>Best offer is ${money(ap.amountCents)} at ${esc(ap.merchant)}. Approve?</h3>
    <p class="why" style="margin:0 0 12px">${esc(ap.rationale)}</p>
    <div class="row"><span>Order</span><b>${ap.quote.packs} × ${esc(ap.title)}</b></div>
    <div class="row"><span>Re-checked price</span><b>${money(ap.amountCents)}</b></div>
    <div class="row"><span>Price when members paid</span><b>${money(ap.quotedCents)}</b></div>
    <div class="row"><span>Each household pays</span><b>${money(Math.ceil(ap.amountCents / ap.households))} <s class="muted" style="font-weight:400">${money(ap.quote.aloneCents)}</s></b></div>
    <div class="row"><span>Comes back to members</span><b style="color:var(--green)">${money(ap.surplusCents)}</b></div>
    <details style="margin-top:10px"><summary class="mono muted" style="font-size:12px;cursor:pointer">${ap.checks.length - fails}/${ap.checks.length} mandate checks passed</summary><ul class="checks">${ap.checks.map((c) => `<li class="${c.ok ? '' : 'no'}"><span><b>${esc(c.rule)}</b> ${esc(c.detail)}</span></li>`).join('')}</ul></details>
    <div class="acts"><button class="btn red" data-approve>Approve</button><button class="btn ghost" data-later>Later</button></div>
    <p class="muted" style="font-size:12px;margin:12px 0 0;text-align:center">Sandbox · the supplier is paid with PayPal Payouts, the rest goes back as refunds</p>
  </div></div>`;
}

function settledCard(p) {
  const rows = p.ledger.filter((l) => l.type === 'refund' || l.type === 'payout');
  const buy = p.ledger.find((l) => l.type === 'purchase');
  return `<div class="card" style="box-shadow:0 0 0 2px var(--green),var(--shadow)"><p class="eyebrow" style="color:var(--green)">${p.status === 'settled' ? 'Done' : 'Refunded'}</p>
    <h3 style="margin:8px 0">${p.status === 'settled' ? `Bought for ${money(buy?.amountCents)}. ${money(rows.reduce((a, l) => a + l.amountCents, 0))} went back to ${rows.length} members.` : `Everyone got their ${money(rows[0]?.amountCents)} back.`}</h3>
    <ul class="members">${rows.map((l) => `<li><span class="avatar">${esc(initials(l.who))}</span><span class="who"><b>${esc(l.who)}</b><small class="pp-id">${esc(l.paypal?.refundId || l.paypal?.payoutBatchId || '')} · ${esc(l.paypal?.mode || '')}${l.paypal?.confirmedByWebhook ? ' · <span class="hook">✓ webhook</span>' : ''}</small></span><span class="amt dir-in">+${money(l.amountCents)}</span></li>`).join('')}</ul>
    ${buy?.paypal ? `<p class="muted" style="font-size:13px;margin:10px 0 0">Supplier paid by PayPal Payouts · <span class="pp-id">${esc(buy.paypal.payoutBatchId || '')}</span>${buy.paypal.itemStatus ? ` · ${esc(buy.paypal.itemStatus.toLowerCase())}` : ''}${buy.paypal.confirmedByWebhook ? ' · <span class="hook">✓ webhook</span>' : ''}</p>` : ''}
    ${p.demo ? '<button class="btn ghost small" data-again style="margin-top:14px">Run the demo again</button>' : ''}</div>`;
}
