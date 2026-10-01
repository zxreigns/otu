import { api, esc, money, toast, STATUS_LABEL, $ } from '../util.js';

// Organiser console on AG Grid: every pool, every member, every cent, every
// mandate verdict. Live: rows are keyed by id, so updates flash in place.

export function consoleView(app, nav) {
  let tab = 'members', grid = null, data = null, poll = null;
  app.innerHTML = `
  <div class="wrap console">
    <div class="pool-head"><div><p class="eyebrow">Organiser console</p><h2 style="margin-top:10px">Every pool, every cent.</h2></div>
      <button class="btn ghost small" id="fresh">New demo pool</button></div>
    <div class="cstats" id="stats"></div>
    <div class="tabs" id="tabs">
      <button data-t="pools">Pools</button><button data-t="members" class="on">Members</button><button data-t="ledger">Ledger</button><button data-t="checks">Mandate verdicts</button>
    </div>
    <div id="grid" class="gridbox"></div>
    <p class="muted" style="font-size:13px;margin-top:12px">Live: refreshes every 3 s. Every money row carries its PayPal id (sandbox) and the mode it ran in.</p>
  </div>`;

  const theme = () => window.agGrid.themeQuartz.withParams({
    fontFamily: 'Inter, system-ui, sans-serif', fontSize: 14, backgroundColor: '#FBF9F5', foregroundColor: '#121212', headerBackgroundColor: '#F2EEE6',
    headerTextColor: '#3A3732', borderColor: '#E2DCD1', rowHoverColor: '#F6F2EA', accentColor: '#E8412F', selectedRowBackgroundColor: '#FBE3DE',
    oddRowBackgroundColor: '#FBF9F5', headerFontWeight: 500, wrapperBorderRadius: 18, spacing: 7, chromeBackgroundColor: '#F2EEE6',
  });

  const statusCell = (p) => p.value ? `<span class="status ${p.value}" style="transform:scale(.9);transform-origin:left">${STATUS_LABEL[p.value] || p.value}</span>` : '';
  const moneyCol = (field, headerName, extra = {}) => ({ field, headerName, type: 'rightAligned', valueFormatter: (p) => (p.value == null ? '' : money(p.value)), cellClass: 'mono', ...extra });

  const DEFS = {
    pools: {
      cols: [
        { field: 'title', headerName: 'Pool', flex: 2, minWidth: 220 },
        { field: 'status', headerName: 'Status', cellRenderer: statusCell, width: 170 },
        { field: 'fillPct', headerName: 'Filled', width: 170, cellRenderer: (p) => `<div class="cell-bar"><div class="bar"><i style="width:${p.value}%"></i></div><span class="mono" style="font-size:12px">${p.data.paid}/${p.data.target}</span></div>` },
        moneyCol('collectedCents', 'Collected'), moneyCol('spentCents', 'Spent'), moneyCol('returnedCents', 'Returned'), moneyCol('balanceCents', 'Held'),
        { field: 'savingsPct', headerName: 'vs alone', valueFormatter: (p) => (p.value ? `−${p.value}%` : ''), cellStyle: { color: '#1E8A5A' }, width: 110 },
        { field: 'createdAt', headerName: 'Opened', valueFormatter: (p) => new Date(p.value).toLocaleString(), width: 180, sort: 'desc' },
      ],
      rows: () => data.pools.map((p) => ({ id: p.id, title: p.title, status: p.status, ...p.summary, savingsPct: p.summary.chosen?.savingsPct, createdAt: p.createdAt })),
      onRow: (e) => nav('/p/' + e.data.id),
    },
    members: {
      cols: [
        { field: 'name', headerName: 'Member', minWidth: 170, flex: 1, pinned: 'left' },
        { field: 'pool', headerName: 'Pool', minWidth: 200, flex: 1 },
        { field: 'state', headerName: 'State', width: 130, cellRenderer: (p) => `<span class="tag ${p.value === 'paid' ? 'paid' : p.value === 'reminded' ? 'reminded' : p.value === 'paid back' ? 'back' : ''}">${p.value}</span>` },
        moneyCol('shareCents', 'Share'), moneyCol('paidCents', 'Paid in'), moneyCol('backCents', 'Back'),
        { field: 'reminders', headerName: 'Reminders', width: 120, type: 'rightAligned' },
        { field: 'captureId', headerName: 'PayPal capture', minWidth: 200, cellClass: 'pp-id' },
        { field: 'invoiceId', headerName: 'PayPal invoice', minWidth: 200, cellClass: 'pp-id' },
      ],
      rows: () => data.pools.flatMap((p) => p.members.map((m) => ({ id: m.id, poolId: p.id, name: m.name, pool: p.title, state: m.backCents ? 'paid back' : m.paidAt ? 'paid' : m.reminders?.length ? 'reminded' : 'invited', shareCents: m.shareCents, paidCents: m.paidAt ? m.shareCents : 0, backCents: m.backCents || 0, reminders: m.reminders?.length || 0, captureId: m.captureId || '', invoiceId: m.invoiceId || '' }))),
      onRow: (e) => nav('/p/' + e.data.poolId),
      totals: (rows) => [{ id: 'total', name: 'Total', pool: `${new Set(rows.map((r) => r.poolId)).size} pools`, state: '', shareCents: sum(rows, 'shareCents'), paidCents: sum(rows, 'paidCents'), backCents: sum(rows, 'backCents'), reminders: sum(rows, 'reminders') }],
    },
    ledger: {
      cols: [
        { field: 'at', headerName: 'When', width: 180, valueFormatter: (p) => new Date(p.value).toLocaleString(), sort: 'desc' },
        { field: 'type', headerName: 'Movement', width: 130, cellRenderer: (p) => `<span class="${p.data.direction === 'in' ? 'dir-in' : 'dir-out'}">${p.value === 'pay_in' ? '↓ pay-in' : p.value === 'purchase' ? '↑ purchase' : p.value === 'refund' ? '↩ refund' : '↗ payout'}</span>` },
        { field: 'who', headerName: 'Counterparty', minWidth: 160, flex: 1 },
        { field: 'pool', headerName: 'Pool', minWidth: 180, flex: 1 },
        moneyCol('signed', 'Amount', { cellStyle: (p) => ({ color: p.value > 0 ? '#1E8A5A' : '#E8412F' }) }),
        { field: 'ref', headerName: 'PayPal reference', minWidth: 220, cellClass: 'pp-id' },
        { field: 'mode', headerName: 'Mode', width: 120 },
      ],
      rows: () => data.pools.flatMap((p) => p.ledger.map((l) => ({ id: l.id, poolId: p.id, at: l.at, type: l.type, direction: l.direction, who: l.who, pool: p.title, signed: l.direction === 'in' ? l.amountCents : -l.amountCents, ref: l.paypal?.captureId || l.paypal?.refundId || l.paypal?.payoutBatchId || l.paypal?.orderId || '', mode: l.paypal?.mode || '' }))),
      onRow: (e) => nav('/p/' + e.data.poolId),
      totals: (rows) => [{ id: 'total', who: 'Net held', pool: '', signed: sum(rows, 'signed'), ref: '', mode: '' }],
    },
    checks: {
      cols: [
        { field: 'at', headerName: 'When', width: 180, valueFormatter: (p) => new Date(p.value).toLocaleString(), sort: 'desc' },
        { field: 'pool', headerName: 'Pool', minWidth: 170 },
        { field: 'kind', headerName: 'Action', width: 120 },
        { field: 'decision', headerName: 'Verdict', width: 150, cellRenderer: (p) => `<span class="d ${p.value}" style="font:500 11px var(--mono);padding:4px 7px;border-radius:6px">${p.value.replace('_', ' ')}</span>` },
        { field: 'passed', headerName: 'Checks', width: 110 },
        { field: 'summary', headerName: 'What happened', flex: 2, minWidth: 320, tooltipField: 'detail' },
      ],
      rows: () => data.pools.flatMap((p) => (p.actions || []).filter((a) => a.checks?.length).map((a) => ({ id: a.id, poolId: p.id, at: a.at, pool: p.title, kind: a.kind, decision: a.decision, passed: `${a.checks.filter((c) => c.ok).length}/${a.checks.length}`, summary: a.summary, detail: a.checks.map((c) => `${c.ok ? '✓' : '✕'} ${c.rule}: ${c.detail}`).join('\n') }))),
      onRow: (e) => nav('/p/' + e.data.poolId),
    },
  };
  const sum = (rows, f) => rows.reduce((a, r) => a + (r[f] || 0), 0);

  function stats() {
    const ps = data.pools;
    const t = (f) => ps.reduce((a, p) => a + (p.summary[f] || 0), 0);
    $('#stats').innerHTML = [['Pools', ps.length, false], ['Collected', money(t('collectedCents')), false], ['Spent with suppliers', money(t('spentCents')), false], ['Paid back', money(t('returnedCents')), true]]
      .map(([k, v, g]) => `<div class="kpi ${g ? 'green' : ''}" style="background:var(--paper);box-shadow:var(--shadow)"><small>${k}</small><b>${v}</b></div>`).join('');
  }

  function mount() {
    const d = DEFS[tab];
    const el = $('#grid'); el.innerHTML = '';
    if (!window.agGrid) { el.innerHTML = '<div class="empty">Loading grid…</div>'; return setTimeout(mount, 300); }
    const rows = d.rows();
    grid = window.agGrid.createGrid(el, {
      theme: theme(),
      columnDefs: d.cols,
      rowData: rows,
      getRowId: (p) => p.data.id,
      defaultColDef: { sortable: true, filter: true, resizable: true, enableCellChangeFlash: true },
      pinnedBottomRowData: d.totals ? d.totals(rows) : undefined,
      animateRows: true,
      rowHeight: 48, headerHeight: 44,
      tooltipShowDelay: 200,
      onRowClicked: (e) => { if (!e.rowPinned) d.onRow?.(e); },
      overlayNoRowsTemplate: '<span class="muted">Nothing here yet</span>',
    });
  }

  function refreshRows() {
    if (!grid) return;
    const d = DEFS[tab];
    const rows = d.rows();
    grid.setGridOption('rowData', rows);
    if (d.totals) grid.setGridOption('pinnedBottomRowData', d.totals(rows));
  }

  async function load(first) {
    try { data = await api('/pools'); stats(); first ? mount() : refreshRows(); } catch (e) { toast(e.message); }
  }

  $('#tabs').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    tab = b.dataset.t; app.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b)); grid?.destroy(); mount();
  };
  $('#fresh').onclick = async () => { const p = await api('/demo/fresh', { method: 'POST' }); nav('/p/' + p.id); };
  load(true);
  poll = setInterval(() => load(false), 3000);
  return () => { clearInterval(poll); grid?.destroy(); };
}
