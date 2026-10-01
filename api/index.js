// Otu API — one zero-dependency Vercel function routes everything under /api.

import { parseRequest, explainChoice } from '../lib/llm.js';
import { sourceOffers } from '../lib/sourcing.js';
import { createPool, rankOffers, addMember, summary, publicView, shareFor } from '../lib/pool.js';
import { DEFAULT_MANDATE, describeMandate } from '../lib/mandate.js';
import { getPool, putPool, listPools, withPool, storeKind, lookupRef, logWebhook, recentWebhooks } from '../lib/store.js';
import { createMemberOrder, captureMemberOrder, demoPay, tick, approve, decline, payInFromInvoice } from '../lib/agent.js';
import { paypal, paypalMode } from '../lib/paypal.js';
import { ensureSeed, buildDemoPool, DEMO_SPECS } from '../lib/seed.js';
import { toCents } from '../lib/money.js';

const VERSION = '0.2.0';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

// Read the raw bytes first (webhook signatures are over the exact body) and
// only fall back to a platform-parsed body if the stream was already drained.
async function readBody(req) {
  const chunks = [];
  try { for await (const c of req) chunks.push(c); } catch { /* stream already consumed */ }
  if (chunks.length) { const raw = Buffer.concat(chunks).toString('utf8'); return { raw, json: safeJson(raw) }; }
  const b = req.body;
  if (b === undefined || b === null) return { raw: '', json: {} };
  return { raw: typeof b === 'string' ? b : JSON.stringify(b), json: typeof b === 'string' ? safeJson(b) : b };
}
const safeJson = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

const view = (pool) => ({ ...publicView(pool), summary: summary(pool), mandateText: describeMandate(pool.mandate) });

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/health', async () => [200, {
  ok: true, version: VERSION, paypal: paypalMode(), store: storeKind(),
  ai: [process.env.GEMINI_API_KEY && 'gemini', process.env.GROQ_API_KEY && 'groq'].filter(Boolean),
  sourcing: process.env.CHANNEL3_API_KEY ? 'channel3' : 'catalog',
  webhooks: !!process.env.PAYPAL_WEBHOOK_ID, sdk: 'paypal-web-sdk-v6',
}]);

route('GET', '/api/config', async () => [200, { paypalClientId: paypal().clientId, paypalMode: paypalMode(), currency: process.env.CURRENCY || 'USD' }]);

// 1. The organiser talks; the agent drafts a pool (no money yet).
route('POST', '/api/pools/draft', async ({ body }) => {
  const text = String(body.text || '').slice(0, 1200);
  if (text.trim().length < 8) return [400, { error: 'Tell the agent what the group wants.' }];
  const { spec, provider, errors } = await parseRequest(process.env, text);
  const mandate = { ...DEFAULT_MANDATE, capPerMemberCents: spec.capPerMember ? toCents(spec.capPerMember) : 2500, minMembers: spec.minMembers, deadline: new Date(Date.now() + (spec.deadlineDays || 3) * 86400e3).toISOString() };
  const { offers, notes, source } = await sourceOffers(spec, process.env);
  const ranked = rankOffers(offers, spec, mandate);
  const why = ranked.length ? await explainChoice(process.env, { spec, ranked }) : { rationale: 'I could not find a sized offer for that yet. Try naming the product and the size per household.' };
  const chosen = ranked.find((o) => o.viable) || null;
  return [200, { spec: { ...spec, capPerMemberCents: mandate.capPerMemberCents, deadline: mandate.deadline }, mandate, mandateText: describeMandate(mandate), offers: ranked.slice(0, 8), chosenOfferId: chosen?.id || null, shareCents: chosen ? shareFor(chosen.quote, mandate) : null, rationale: why.rationale, thinking: { parse: provider, explain: why.provider, sourcing: source, notes, errors } }];
});

// 2. The organiser confirms; the pool opens.
route('POST', '/api/pools', async ({ body }) => {
  const d = body.draft;
  if (!d?.spec || !Array.isArray(d.offers)) return [400, { error: 'draft missing' }];
  const members = (body.members || []).filter((m) => m && m.name).slice(0, 50).map((m) => ({ name: String(m.name).slice(0, 60), email: String(m.email || '').slice(0, 120) }));
  const pool = createPool({ spec: d.spec, offers: d.offers, organiser: { name: String(body.organiser || 'Organiser').slice(0, 60) }, request: d.request || '', members, mandate: d.mandate });
  if (d.chosenOfferId && pool.offers.some((o) => o.id === d.chosenOfferId)) pool.chosenOfferId = d.chosenOfferId;
  pool.actions.push({ id: 'a_open', at: new Date().toISOString(), actor: 'agent', kind: 'observe', summary: `Pool opened. ${pool.offers.length} offers sourced; ${pool.members.length} members invited at ${'$' + ((pool.members[0]?.shareCents || 0) / 100).toFixed(2)} each.`, reasoning: d.rationale || null, decision: 'info', checks: [] });
  await putPool(pool);
  return [201, view(pool)];
});

route('GET', '/api/pools', async () => {
  await ensureSeed();
  const pools = await listPools(50);
  return [200, { pools: pools.map((p) => ({ id: p.id, title: p.title, status: p.status, createdAt: p.createdAt, demo: !!p.demo, summary: summary(p), members: publicView(p).members, ledger: p.ledger, mandate: p.mandate })) }];
});

route('GET', '/api/pools/:id', async ({ params }) => {
  const p = await getPool(params.id);
  return p ? [200, view(p)] : [404, { error: 'pool not found' }];
});

const mutate = (fn) => async (ctx) => {
  const r = await withPool(ctx.params.id, (pool) => fn(pool, ctx));
  if (r.notFound) return [404, { error: 'pool not found' }];
  const out = r.out || {};
  return [out.ok === false ? 409 : 200, { result: out, pool: view(r.pool) }];
};

route('POST', '/api/pools/:id/members', mutate((pool, { body }) => {
  if (pool.status !== 'collecting') return { ok: false, error: 'pool is no longer collecting' };
  if (pool.members.length >= 50) return { ok: false, error: 'pool is full' };
  const m = addMember(pool, { name: String(body.name || 'Member').slice(0, 60), email: String(body.email || '').slice(0, 120) });
  pool.actions.push({ id: 'a_' + m.id, at: new Date().toISOString(), actor: 'member', kind: 'observe', summary: `${m.name} joined`, decision: 'info', checks: [] });
  return { ok: true, memberId: m.id };
}));
route('POST', '/api/pools/:id/members/:mid/order', mutate((pool, { params }) => createMemberOrder(pool, params.mid, process.env)));
route('POST', '/api/pools/:id/members/:mid/capture', mutate((pool, { params, body }) => captureMemberOrder(pool, params.mid, body.orderId, process.env)));
route('POST', '/api/pools/:id/members/:mid/demo-pay', mutate((pool, { params }) => demoPay(pool, params.mid, process.env)));
route('POST', '/api/pools/:id/tick', mutate(async (pool, { body }) => ({ ok: true, actions: await tick(pool, process.env, { force: !!body.force }) })));
route('POST', '/api/pools/:id/approve', mutate((pool, { body }) => approve(pool, process.env, String(body.by || 'organiser').slice(0, 40))));
route('POST', '/api/pools/:id/decline', mutate((pool, { body }) => decline(pool, process.env, String(body.by || 'organiser').slice(0, 40))));

// A fresh copy of the demo pool (for judges and for each demo-video take).
route('POST', '/api/demo/fresh', async () => {
  const d = DEMO_SPECS[0];
  const spec = { ...d.spec, deadline: new Date(Date.now() + 3 * 86400e3).toISOString() };
  const { pool } = await buildDemoPool({ request: d.request, spec });
  pool.actions.push({ id: 'a_seed', at: new Date().toISOString(), actor: 'agent', kind: 'observe', summary: `Pool opened from the organiser's message. Sourced ${pool.offers.length} offers; picked ${pool.offers.find((o) => o.id === pool.chosenOfferId)?.merchant}.`, decision: 'info', checks: [] });
  await putPool(pool);
  return [201, view(pool)];
});

// PayPal webhooks: the ledger follows what PayPal says actually happened.
// Every delivery is verified, logged, matched to its pool through the
// reference index, and stamped onto the ledger row it confirms.
const EVENT_LABEL = {
  'CHECKOUT.ORDER.APPROVED': 'Order approved by payer', 'CHECKOUT.ORDER.COMPLETED': 'Order completed',
  'PAYMENT.CAPTURE.COMPLETED': 'Pay-in captured', 'PAYMENT.CAPTURE.PENDING': 'Pay-in pending', 'PAYMENT.CAPTURE.DENIED': 'Pay-in denied',
  'PAYMENT.CAPTURE.REFUNDED': 'Refund settled', 'PAYMENT.CAPTURE.REVERSED': 'Pay-in reversed',
  'PAYMENT.PAYOUTSBATCH.SUCCESS': 'Payout batch paid', 'PAYMENT.PAYOUTSBATCH.PROCESSING': 'Payout batch processing', 'PAYMENT.PAYOUTSBATCH.DENIED': 'Payout batch denied',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': 'Payout claimed', 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED': 'Payout unclaimed', 'PAYMENT.PAYOUTS-ITEM.FAILED': 'Payout failed',
  'PAYMENT.PAYOUTS-ITEM.RETURNED': 'Payout returned', 'PAYMENT.PAYOUTS-ITEM.BLOCKED': 'Payout blocked', 'PAYMENT.PAYOUTS-ITEM.HELD': 'Payout held',
  'INVOICING.INVOICE.PAID': 'Invoice paid', 'INVOICING.INVOICE.CANCELLED': 'Invoice cancelled',
};
function eventRefs(res) {
  return [res.id, res.supplementary_data?.related_ids?.order_id, res.supplementary_data?.related_ids?.capture_id, res.payout_batch_id,
    res.batch_header?.payout_batch_id, res.invoice?.id, ...(res.links || []).filter((l) => l.rel === 'up').map((l) => l.href.split('/').pop())].filter(Boolean);
}
function eventAmount(res) {
  const a = res.amount || res.payout_item?.amount || res.batch_header?.amount || res.invoice?.amount || res.purchase_units?.[0]?.amount;
  const v = a?.value ?? a?.total; return v != null ? `${a.currency_code || a.currency || ''} ${v}`.trim() : null;
}

route('POST', '/api/paypal/webhook', async ({ req, raw, body }) => {
  const v = await paypal().verifyWebhook(req.headers, raw).catch((e) => ({ ok: false, method: e.message }));
  const type = body.event_type || 'unknown';
  const res = body.resource || {};
  const refs = eventRefs(res);
  let poolId = res.custom_id || res.purchase_units?.[0]?.custom_id || null;
  for (const r of refs) { if (poolId) break; poolId = await lookupRef(r).catch(() => null); }
  const status = res.status || res.transaction_status || res.batch_header?.batch_status || res.invoice?.status || null;
  const entry = { id: body.id, at: new Date().toISOString(), created: body.create_time, type, label: EVENT_LABEL[type] || type, resourceId: res.id || res.payout_item_id || res.batch_header?.payout_batch_id || res.invoice?.id, status, amount: eventAmount(res), poolId, verified: v.ok, method: v.method };
  await logWebhook(entry).catch(() => {});
  if (!v.ok) return [400, { error: 'unverified' }];
  if (poolId) {
    await withPool(poolId, async (pool) => {
      if ((pool.webhooks || []).some((w) => w.id === body.id)) return;
      pool.webhooks = [...(pool.webhooks || []).slice(-40), entry];
      const ids = new Set(refs);
      for (const row of pool.ledger) {
        const p = row.paypal || {};
        if ([p.captureId, p.refundId, p.orderId, p.payoutBatchId].some((x) => x && ids.has(x))) {
          p.webhooks = [...new Set([...(p.webhooks || []), type])];
          p.confirmedByWebhook = type;
          if (type.startsWith('PAYMENT.PAYOUTS-ITEM.')) p.itemStatus = res.transaction_status;
          row.paypal = p;
        }
      }
      if (type === 'INVOICING.INVOICE.PAID') {
        const m = pool.members.find((x) => x.invoiceId === res.invoice?.id);
        if (m) await payInFromInvoice(pool, m, res.invoice);
      }
    });
  }
  return [200, { ok: true }];
});

route('GET', '/api/paypal/events', async ({ query }) => {
  const all = await recentWebhooks(60);
  return [200, { webhookConfigured: !!process.env.PAYPAL_WEBHOOK_ID, events: query.pool ? all.filter((e) => e.poolId === query.pool) : all }];
});

route('GET', '/api/paypal/client-token', async () => {
  const t = await paypal().clientToken();
  return t ? [200, t] : [404, { error: 'simulated mode' }];
});

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const { raw, json } = req.method === 'GET' ? { raw: '', json: {} } : await readBody(req);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.re);
      if (!m) continue;
      const [status, body] = await r.fn({ req, params: m.groups || {}, body: json, raw, query: Object.fromEntries(url.searchParams) });
      return send(res, status, body);
    }
    send(res, 404, { error: 'no such endpoint' });
  } catch (e) {
    console.error(e);
    send(res, e.status && e.status < 500 ? 400 : 500, { error: e.message || 'server error' });
  }
}
