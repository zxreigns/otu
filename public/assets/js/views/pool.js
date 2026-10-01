import { api, esc, money, initials, ago, until, toast, STATUS_LABEL, $ } from '../util.js';

let sdkLoading = null;
function loadPayPal(clientId) {
  if (window.paypal) return Promise.resolve(window.paypal);
  if (!sdkLoading) sdkLoading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons&disable-funding=paylater,venmo`;
    s.onload = () => res(window.paypal); s.onerror = () => rej(new Error('PayPal SDK failed to load'));
    document.head.appendChild(s);
  });
  return sdkLoading;
}

export function poolView(app, nav, id, cfg) {
  let pool = null, poll = null, lastRev = -1, selected = null, crowdRunning = false, seenPaid = new Set(), ppBusy = false;

  app.innerHTML = `<div class="wrap"><div class="empty">Loading pool…</div></div>`;

  async function load() {
    try {
      const p = await api('/pools/' + id);
      if (p.rev !== lastRev && !ppBusy) { pool = p; lastRev = p.rev; render(); }
    } catch (e) { app.innerHTML = `<div class="wrap"><div class="empty">${esc(e.message)}. <a href="/" data-link>Back home</a></div></div>`; stop(); }
  }
  const stop = () => clearInterval(poll);
  poll = setInterval(load, 2500);
  load();

  async function act(path, body, label) {
    try {
      const r = await api(`/pools/${id}${path}`, { method: 'POST', body: body || {} });
      if (r.pool) { pool = r.pool; lastRev = pool.rev; render(); }
      if (r.result?.ok === false) toast(r.result.error || blockedText(r.result.verdict) || 'The mandate said no.');
      else if (label) toast(label);
      return r;
    } catch (e) { toast(e.message); }
  }
  const blockedText = (v) => v && 'Blocked: ' + v.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ');

  function render() {
    const p = pool, s = p.summary, chosen = p.offers.find((o) => o.id === p.chosenOfferId);
    const paidNow = new Set(p.members.filter((m) => ['paid', 'settled', 'refunded'].includes(m.status) || m.paidAt).map((m) => m.id));
    const fresh = [...paidNow].filter((x) => !seenPaid.has(x) && seenPaid.size);
    seenPaid = paidNow;
    const unpaid = p.members.filter((m) => !m.paidAt);
    if (!selected || !unpaid.find((m) => m.id === selected)) selected = unpaid[0]?.id || null;
    const sel = p.members.find((m) => m.id === selected);
    const back = p.ledger.filter((l) => l.type === 'refund' || l.type === 'payout').reduce((a, l) => a + l.amountCents, 0);

    app.innerHTML = `
    <div class="wrap">
      <div class="pool-head">
        <div><p class="eyebrow">${esc(p.organiser?.name || 'Organiser')}'s pool · ${esc(until(p.mandate.deadline))}</p><h2 style="margin-top:10px">${esc(p.title)}</h2></div>
        <span class="status ${p.status}">${STATUS_LABEL[p.status] || p.status}</span>
      </div>
      <div class="pool">
        <div class="stack">
          <div class="card">
            <div class="fill">
              <div class="ring" style="--p:${s.fillPct}"><div><div><b>${s.paid}/${s.target}</b><br><span>households in</span></div></div></div>
              <div class="kpis">
                <div class="kpi"><small>Held</small><b>${money(s.balanceCents)}</b></div>
                <div class="kpi"><small>Spent</small><b>${money(s.spentCents)}</b></div>
                <div class="kpi green"><small>Paid back</small><b>${money(back)}</b></div>
              </div>
            </div>
          </div>
          ${chosen ? `<div class="card">
            <div class="offer"><span class="thumb" ${chosen.image ? `style="background-image:url('${esc(chosen.image)}')"` : ''}>${chosen.image ? '' : esc(chosen.merchant[0])}</span>
              <span class="meta"><b>${esc(chosen.title)}</b><small>${esc(chosen.merchant)} · ${chosen.quote.packs} pack${chosen.quote.packs > 1 ? 's' : ''} for ${s.target} households · ${esc(chosen.source === 'channel3' ? 'live via Channel3' : 'catalog price')}</small></span>
              <span class="save">−${chosen.quote.savingsPct}% vs alone</span></div>
            <div class="price-compare"><b>${money(chosen.quote.perHouseholdCents)}</b><span class="muted">a household, vs</span><s>${money(chosen.quote.aloneCents)}</s><span class="muted">buying alone</span></div>
          </div>` : ''}
          ${p.status === 'awaiting_approval' && p.pendingApproval ? approvalCard(p.pendingApproval) : ''}
          ${p.status === 'settled' || p.status === 'refunded' ? settledCard(p) : ''}
          <div class="card">
            <div class="row-between" style="margin-bottom:6px"><p class="eyebrow">Members · each pays ${money(p.members[0]?.shareCents)}</p>
              ${p.status === 'collecting' && unpaid.length ? `<button class="btn ghost small" id="crowd">${crowdRunning ? 'Paying…' : `Demo: pay the other ${unpaid.length}`}</button>` : ''}</div>
            <ul class="members">${p.members.map((m) => memberRow(m, fresh.includes(m.id), p)).join('')}</ul>
            ${p.status === 'collecting' && sel ? `<div class="card flat" style="margin-top:12px;background:var(--cream);border:0">
              <div class="row-between"><span>Pay as <b>${esc(sel.name)}</b> · <span class="mono">${money(sel.shareCents)}</span></span>
              <select id="who" style="width:auto;padding:8px 10px">${unpaid.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
              <div id="pp-slot" class="paypal-slot"></div>
              ${cfg.paypalMode === 'sandbox' ? '<p class="muted" style="font-size:13px;margin:6px 0 0">PayPal sandbox: log in with a sandbox personal account. No real money.</p>' : `<button class="btn primary" id="sim-pay" style="width:100%;justify-content:center;margin-top:6px">Pay ${money(sel.shareCents)} (sandbox simulation)</button><p class="muted" style="font-size:13px;margin:8px 0 0">PayPal keys aren't configured on this deployment, so payments run through the built-in sandbox simulator.</p>`}
            </div>` : ''}
          </div>
          <div class="card flat"><p class="eyebrow" style="margin-bottom:8px">Mandate</p>${p.mandateText.map((t) => `<div style="font-size:14px;padding:3px 0">· ${esc(t)}</div>`).join('')}</div>
          ${p.request ? `<p class="muted" style="font-size:14px">Started from: “${esc(p.request)}”</p>` : ''}
        </div>
        <aside class="card agent">
          <div class="head"><span class="pulse"></span><b>Agent</b><span class="muted" style="font-size:13px;margin-left:auto">${p.actions.length} steps</span></div>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button class="btn primary small" id="tick" ${['collecting', 'filled'].includes(p.status) ? '' : 'disabled'}>Run the agent</button>
            <a class="btn ghost small" href="/console" data-link>Console</a>
          </div>
          <ul class="feed">${p.actions.slice().reverse().map(feedItem).join('')}</ul>
        </aside>
      </div>
    </div>
    ${p.status === 'awaiting_approval' && p.pendingApproval && !sessionStorage.getItem('dismiss:' + p.pendingApproval.id) ? sheet(p.pendingApproval, p) : ''}`;

    const c = $('#crowd'); if (c) c.onclick = crowd;
    const w = $('#who'); if (w) w.onchange = () => { selected = w.value; render(); };
    $('#tick').onclick = () => act('/tick', { force: true }, 'Agent ran');
    const sp = $('#sim-pay'); if (sp) sp.onclick = () => act(`/members/${selected}/demo-pay`, {}, 'Payment captured');
    app.querySelectorAll('[data-approve]').forEach((b) => (b.onclick = () => act('/approve', { by: p.organiser?.name || 'organiser' }, 'Approved. Buying and paying everyone back…')));
    app.querySelectorAll('[data-decline]').forEach((b) => (b.onclick = () => act('/decline', { by: p.organiser?.name || 'organiser' }, 'Declined. Refunding everyone.')));
    app.querySelectorAll('[data-later]').forEach((b) => (b.onclick = () => { sessionStorage.setItem('dismiss:' + p.pendingApproval.id, 1); render(); }));
    if (cfg.paypalMode === 'sandbox' && sel && p.status === 'collecting') mountButtons(sel);
  }

  async function mountButtons(member) {
    const slot = $('#pp-slot'); if (!slot) return;
    try {
      const pp = await loadPayPal(cfg.paypalClientId);
      slot.innerHTML = '';
      await pp.Buttons({
        style: { layout: 'horizontal', color: 'black', shape: 'pill', label: 'pay', height: 44, tagline: false },
        onClick: () => { ppBusy = true; },
        onCancel: () => { ppBusy = false; },
        createOrder: async () => { const r = await api(`/pools/${id}/members/${member.id}/order`, { method: 'POST' }); if (!r.result?.orderId) throw new Error(blockedText(r.result?.verdict) || 'blocked'); return r.result.orderId; },
        onApprove: async (data) => { ppBusy = false; await act(`/members/${member.id}/capture`, { orderId: data.orderID }, `${member.name} paid through PayPal`); },
        onError: (err) => { ppBusy = false; toast('PayPal: ' + (err?.message || err)); },
      }).render(slot);
    } catch (e) { slot.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  }

  async function crowd() {
    if (crowdRunning) return; crowdRunning = true; render();
    for (const m of pool.members.filter((x) => !x.paidAt)) {
      await act(`/members/${m.id}/demo-pay`);
      await new Promise((r) => setTimeout(r, 650));
      if (pool.status !== 'collecting') break;
    }
    crowdRunning = false;
    if (pool.status === 'filled') await act('/tick', {}, 'Pool filled. The agent is re-checking prices…');
    else render();
  }

  return stop;
}

function memberRow(m, isFresh, p) {
  const state = m.backCents ? `<span class="tag back">+${money(m.backCents)} back</span>` : m.paidAt ? '<span class="tag paid">Paid</span>' : m.reminders?.length ? `<span class="tag reminded">Reminded ×${m.reminders.length}</span>` : '<span class="tag">Invited</span>';
  return `<li class="${m.paidAt ? 'paid' : ''} ${isFresh ? 'just' : ''}"><span class="avatar">${esc(initials(m.name))}</span><span class="who"><b>${esc(m.name)}</b><small>${m.paidAt ? 'paid ' + ago(m.paidAt) + (m.captureId ? ` · <span class="pp-id">${esc(m.captureId)}</span>` : '') : esc(m.email || '')}</small></span><span class="amt">${money(m.shareCents)}</span>${state}</li>`;
}

function feedItem(a) {
  const checks = a.checks?.length ? `<details><summary>${a.checks.filter((c) => c.ok).length}/${a.checks.length} mandate checks</summary><ul class="checks">${a.checks.map((c) => `<li class="${c.ok ? '' : 'no'}"><span><b>${esc(c.rule)}</b> ${esc(c.detail)}</span></li>`).join('')}</ul></details>` : '';
  const mode = a.result?.mode ? ` · ${a.result.mode}` : '';
  return `<li><div class="t"><span>${esc(a.actor)} · ${esc(a.kind)}${esc(mode)}</span><span class="d ${a.decision}">${esc(a.decision.replace('_', ' '))}</span><span style="margin-left:auto">${ago(a.at)}</span></div>${esc(a.summary)}${a.reasoning ? `<div class="why">${esc(a.reasoning)}</div>` : ''}${checks}</li>`;
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
    <ul class="members">${rows.map((l) => `<li><span class="avatar">${esc(initials(l.who))}</span><span class="who"><b>${esc(l.who)}</b><small class="pp-id">${esc(l.paypal?.refundId || l.paypal?.payoutBatchId || '')} · ${esc(l.paypal?.mode || '')}</small></span><span class="amt dir-in">+${money(l.amountCents)}</span></li>`).join('')}</ul>
    ${p.demo ? '<button class="btn ghost small" id="again" onclick="fetch(\'/api/demo/fresh\',{method:\'POST\'}).then(r=>r.json()).then(j=>{history.pushState({},\'\',\'/p/\'+j.id);dispatchEvent(new PopStateEvent(\'popstate\'))})">Run the demo again</button>' : ''}</div>`;
}
