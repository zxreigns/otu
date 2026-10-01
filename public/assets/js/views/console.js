import { api, esc, money, toast, STATUS_LABEL, $ } from '../util.js';

// Organiser console on AG Grid: every pool, every member, every cent, every
// mandate verdict. Live: rows are keyed by id, so updates flash in place.

const loaded = {};
const loadScript = (src) => loaded[src] || (loaded[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }));

export function consoleView(app, nav) {
  let view = 'members', grid = null, data = null, poll = null, events = [], charts = {}, chartKey = '';
  app.innerHTML = `
  <div class="wrap console">
    <div class="pool-head"><div><p class="eyebrow">Organiser console</p><h2 style="margin-top:10px">Every pool, every cent.</h2></div>
      <button class="btn ghost small" id="fresh">New demo pool</button></div>
    <div class="cstats" id="stats"></div>
    <div class="charts"><div class="chart" id="ch-pools"></div><div class="chart" id="ch-split"></div></div>
    <div class="tabs" id="tabs">
      <button data-t="pools">Pools</button><button data-t="members" class="on">Members</button><button data-t="ledger">Ledger</button><button data-t="checks">Mandate verdicts</button><button data-t="events">PayPal webhooks</button>
    </div>
    <div id="grid" class="gridbox"></div>
    <p class="muted" style="font-size:13px;margin-top:12px">Live: refreshes every 3 s. Every money row carries its PayPal id (sandbox) and the mode it ran in; the webhooks tab shows each PayPal delivery and how its signature was verified.</p>
  </div>`;

  const theme = () => window.agGrid.themeQuartz.withParams({
    fontFamily: 'Inter, system-ui, sans-serif', fontSize: 14, backgroundColor: '#FBF9F5', foregroundColor: '#121212', headerBackgroundColor: '#F2EEE6',
    headerTextColor: '#3A3732', borderColor: '#E2DCD1', rowHoverColor: '#F6F2EA', accentColor: '#E8412F', selectedRowBackgroundColor: '#FBE3DE',
    oddRowBackgroundColor: '#FBF9F5', headerFontWeight: 500, wrapperBorderRadius: 18, spacing: 7, chromeBackgroundColor: '#F2EEE6',
  });

  const statusCell = (p) => p.value ? `<span class="status ${p.value}" style="transform:scale(.9);transform-origin:left">${STATUS_LABEL[p.value] || p.value}</span>` : '';
  const moneyCol = (field, headerName, extra = {}) => ({ field, headerName, type: 'rightAligned', valueFormatter: (p) => (p.value == null ? '' : money(p.value)), cellClass: ['mono', 'ag-right-aligned-cell'], ...extra });

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
  DEFS.events = {
    cols: [
      { field: 'at', headerName: 'Received', width: 180, valueFormatter: (p) => new Date(p.value).toLocaleString(), sort: 'desc' },
      { field: 'label', headerName: 'Event', minWidth: 190, flex: 1, tooltipField: 'type' },
      { field: 'amount', headerName: 'Amount', width: 130, cellClass: 'mono' },
      { field: 'status', headerName: 'Status', width: 130 },
      { field: 'resourceId', headerName: 'PayPal resource', minWidth: 210, cellClass: 'pp-id' },
      { field: 'pool', headerName: 'Pool', minWidth: 170 },
      { field: 'verified', headerName: 'Signature', minWidth: 200, cellRenderer: (p) => `<span class="${p.value ? 'verified' : 'unverified'}">${p.value ? '✓ verified' : '✕ rejected'}</span>`, tooltipField: 'method' },
    ],
    rows: () => events.map((e) => ({ ...e, id: e.id || e.at, pool: data.pools.find((p) => p.id === e.poolId)?.title || (e.poolId ? e.poolId : '—') })),
    onRow: (e) => e.data.poolId && nav('/p/' + e.data.poolId),
  };
  const sum = (rows, f) => rows.reduce((a, r) => a + (r[f] || 0), 0);

  function stats() {
    const ps = data.pools;
    const t = (f) => ps.reduce((a, p) => a + (p.summary[f] || 0), 0);
    $('#stats').innerHTML = [['Pools', ps.length, false], ['Collected', money(t('collectedCents')), false], ['Spent with suppliers', money(t('spentCents')), false], ['Paid back', money(t('returnedCents')), true]]
      .map(([k, v, g]) => `<div class="kpi ${g ? 'green' : ''}" style="background:var(--paper);box-shadow:var(--shadow)"><small>${k}</small><b>${v}</b></div>`).join('');
  }

  function drawCharts() {
    if (!window.agCharts) return;
    const ps = data.pools.slice(0, 8).reverse();
    const t = (f) => data.pools.reduce((a, p) => a + (p.summary[f] || 0), 0);
    const key = JSON.stringify(ps.map((p) => [p.id, p.summary.collectedCents, p.summary.spentCents, p.summary.returnedCents]));
    if (key === chartKey) return; chartKey = key;
    const base = { background: { fill: 'transparent' }, theme: { baseTheme: 'ag-default', palette: { fills: ['#121212', '#E8412F', '#1E8A5A', '#B7791F'], strokes: ['#121212', '#E8412F', '#1E8A5A', '#B7791F'] }, params: { fontFamily: 'Inter, system-ui, sans-serif', foregroundColor: '#3A3732' } } };
    const bars = { ...base, container: $('#ch-pools'), title: { text: 'Where each pool’s money went', fontFamily: 'Instrument Serif, Georgia, serif', fontSize: 22, color: '#121212' },
      data: ps.map((p) => ({ pool: p.title.length > 22 ? p.title.slice(0, 21) + '…' : p.title, collected: p.summary.collectedCents / 100, spent: p.summary.spentCents / 100, back: p.summary.returnedCents / 100 })),
      series: [{ type: 'bar', xKey: 'pool', yKey: 'collected', yName: 'Collected', cornerRadius: 6 }, { type: 'bar', xKey: 'pool', yKey: 'spent', yName: 'Paid to supplier', cornerRadius: 6 }, { type: 'bar', xKey: 'pool', yKey: 'back', yName: 'Back to members', cornerRadius: 6 }],
      axes: [{ type: 'category', position: 'bottom', label: { fontSize: 11 } }, { type: 'number', position: 'left', label: { formatter: (p) => '$' + p.value } }],
      legend: { position: 'bottom' } };
    const split = { ...base, container: $('#ch-split'), title: { text: 'Every dollar, accounted for', fontFamily: 'Instrument Serif, Georgia, serif', fontSize: 22, color: '#121212' },
      data: [{ k: 'Supplier', v: t('spentCents') / 100 }, { k: 'Back to members', v: t('returnedCents') / 100 }, { k: 'Held in open pools', v: t('balanceCents') / 100 }].filter((d) => d.v > 0),
      series: [{ type: 'donut', angleKey: 'v', legendItemKey: 'k', innerRadiusRatio: 0.68, fills: ['#121212', '#1E8A5A', '#B7791F'], strokeWidth: 0, innerLabels: [{ text: '$' + (t('collectedCents') / 100).toLocaleString(undefined, { maximumFractionDigits: 0 }), fontSize: 26, fontFamily: 'Instrument Serif, Georgia, serif' }, { text: 'collected', fontSize: 11 }] }],
      legend: { position: 'bottom' } };
    if (charts.bars) { charts.bars.update(bars); charts.split.update(split); }
    else { charts.bars = window.agCharts.AgCharts.create(bars); charts.split = window.agCharts.AgCharts.create(split); }
  }

  function mount() {
    const d = DEFS[view];
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
    const d = DEFS[view];
    const rows = d.rows();
    grid.setGridOption('rowData', rows);
    if (d.totals) grid.setGridOption('pinnedBottomRowData', d.totals(rows));
  }

  async function load(first) {
    try {
      const [d, ev] = await Promise.all([api('/pools'), api('/paypal/events').catch(() => ({ events: [] }))]);
      data = d; events = ev.events || [];
      stats(); drawCharts(); first ? mount() : refreshRows();
    } catch (e) { toast(e.message); }
  }

  $('#tabs').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    view = b.dataset.t; app.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b)); grid?.destroy(); mount();
  };
  $('#fresh').onclick = async () => { const p = await api('/demo/fresh', { method: 'POST' }); nav('/p/' + p.id); };
  Promise.all([loadScript('/vendor/ag-grid-community.min.js'), loadScript('/vendor/ag-charts-community.min.js')]).then(() => load(true), (e) => toast('Could not load the grid: ' + e));
  poll = setInterval(() => data && load(false), 3000);
  return () => { clearInterval(poll); grid?.destroy(); charts.bars?.destroy(); charts.split?.destroy(); };
}
