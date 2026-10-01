// Persistence. Upstash Redis over REST when configured (KV_REST_API_URL /
// KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL / _TOKEN); otherwise process
// memory, which is fine locally and for a warm serverless instance.

const URL_ = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PREFIX = process.env.STORE_PREFIX || 'otu:';

async function redis(cmd) {
  const r = await fetch(URL_(), { method: 'POST', headers: { authorization: `Bearer ${TOK()}`, 'content-type': 'application/json' }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (j.error) throw new Error('redis: ' + j.error);
  return j.result;
}

const mem = globalThis.__otuMem || (globalThis.__otuMem = new Map());

export const storeKind = () => (URL_() && TOK() ? 'redis' : 'memory');

export async function getPool(id) {
  if (storeKind() === 'redis') { const v = await redis(['GET', PREFIX + 'pool:' + id]); return v ? JSON.parse(v) : null; }
  const v = mem.get('pool:' + id); return v ? structuredClone(v) : null;
}
export async function putPool(pool) {
  pool.updatedAt = new Date().toISOString();
  pool.rev = (pool.rev || 0) + 1;
  if (storeKind() === 'redis') {
    await redis(['SET', PREFIX + 'pool:' + pool.id, JSON.stringify(pool)]);
    await redis(['ZADD', PREFIX + 'pools', String(Date.parse(pool.createdAt)), pool.id]);
  } else { mem.set('pool:' + pool.id, structuredClone(pool)); }
  return pool;
}
export async function listPools(limit = 50) {
  if (storeKind() === 'redis') {
    const ids = await redis(['ZREVRANGE', PREFIX + 'pools', '0', String(limit - 1)]);
    if (!ids?.length) return [];
    const vals = await redis(['MGET', ...ids.map((i) => PREFIX + 'pool:' + i)]);
    return vals.filter(Boolean).map((v) => JSON.parse(v));
  }
  return [...mem.entries()].filter(([k]) => k.startsWith('pool:')).map(([, v]) => structuredClone(v)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
export async function deletePool(id) {
  if (storeKind() === 'redis') { await redis(['DEL', PREFIX + 'pool:' + id]); await redis(['ZREM', PREFIX + 'pools', id]); }
  else mem.delete('pool:' + id);
}

// Serialise writes to one pool inside an instance so two quick taps don't race.
const locks = new Map();
export async function withPool(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  locks.set(id, prev.then(() => next));
  await prev;
  try {
    const pool = await getPool(id);
    if (!pool) return { notFound: true };
    const out = await fn(pool);
    await putPool(pool);
    return { pool, out };
  } finally { release(); if (locks.get(id) === next) locks.delete(id); }
}
