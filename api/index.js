// Otu API — one zero-dependency Vercel function routes everything under /api.

import { parseRequest, explainChoice } from '../lib/llm.js';
import { sourceOffers } from '../lib/sourcing.js';
import { createPool, rankOffers, addMember, summary, publicView, shareFor } from '../lib/pool.js';
import { DEFAULT_MANDATE, describeMandate } from '../lib/mandate.js';
import { getPool, putPool, listPools, withPool, storeKind } from '../lib/store.js';
import { createMemberOrder, captureMemberOrder, demoPay, tick, approve, decline } from '../lib/agent.js';
import { paypal, paypalMode } from '../lib/paypal.js';
import { ensureSeed, buildDemoPool, DEMO_SPECS } from '../lib/seed.js';
import { toCents } from '../lib/money.js';

const VERSION = '0.1.0';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body !== undefined) return { raw: typeof req.body === 'string' ? req.body : JSON.stringify(req.body), json: typeof req.body === 'string' ? safeJson(req.body) : req.body };
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return { raw, json: safeJson(raw) };
}
const safeJson = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

const view = (pool) => ({ ...publicView(pool), summary: summary(pool), mandateText: describeMandate(pool.mandate) });

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/health', async () => [200, {
  ok: true, version: VERSION, paypal: paypalMode(), store: storeKind(),
  ai: [process.env.GEMINI_API_KEY && 'gemini', process.env.GROQ_API_KEY && 'groq'].filter(Boolean),
  sourcing: process.env.CHANNEL3_API_KEY ? 'channel3' : 'catalog',
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
route('POST', '/api/paypal/webhook', async ({ req, raw, body }) => {
  const ok = await paypal().verifyWebhook(req.headers, raw).catch(() => false);
  if (!ok) return [400, { error: 'unverified' }];
  const type = body.event_type;
  const res = body.resource || {};
  const poolId = res.custom_id || res.purchase_units?.[0]?.custom_id;
  if (poolId) {
    await withPool(poolId, (pool) => {
      pool.webhooks = [...(pool.webhooks || []).slice(-30), { at: new Date().toISOString(), type, id: res.id, status: res.status }];
      const row = pool.ledger.find((l) => l.paypal?.captureId === res.id || l.paypal?.refundId === res.id);
      if (row) row.paypal.confirmedByWebhook = type;
    });
  }
  return [200, { ok: true }];
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
