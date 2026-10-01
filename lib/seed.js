// Demo pools so a first-time visitor (or a judge) lands on something alive.

import { createPool } from './pool.js';
import { sourceOffers } from './sourcing.js';
import { putPool, listPools } from './store.js';

const CAST = [
  ['Funmi Adeyemi', 'funmi.adeyemi'], ['Chidi Okafor', 'chidi.okafor'], ['Tolu Bakare', 'tolu.bakare'],
  ['Amaka Eze', 'amaka.eze'], ['Ibrahim Musa', 'ibrahim.musa'], ['Grace Oyelaran', 'grace.oyelaran'],
];

export function demoMembers(n, domain = 'otu-demo.example') {
  return CAST.slice(0, n).map(([name, handle]) => ({ name, email: `${handle}@${domain}` }));
}

export async function buildDemoPool({ request, spec, paidCount = 0, organiser }, env = process.env) {
  const { offers, notes } = await sourceOffers(spec, env);
  const pool = createPool({ spec, offers, organiser: organiser || { name: 'Kachi (organiser)' }, request, members: demoMembers(spec.households) });
  pool.sourcingNotes = notes;
  pool.demo = true;
  return { pool, paidCount };
}

export const DEMO_SPECS = [
  {
    request: 'Six of us on Adeyemi Close want a big bag of jasmine rice split 6 ways, about 8 lb each. Close it Friday, nobody pays more than $14.',
    spec: { title: 'Jasmine rice for Adeyemi Close', item: 'jasmine rice', query: 'jasmine rice', unit: 'lb', qtyPerHousehold: 8, households: 6, capPerMemberCents: 1400, minMembers: 4, deadline: null },
  },
];

export async function ensureSeed(env = process.env) {
  const pools = await listPools(5);
  if (pools.length) return pools;
  const out = [];
  for (const d of DEMO_SPECS) {
    const spec = { ...d.spec, deadline: new Date(Date.now() + 3 * 86400e3).toISOString() };
    const { pool } = await buildDemoPool({ request: d.request, spec }, env);
    pool.actions.push({ id: 'a_seed', at: new Date().toISOString(), actor: 'agent', kind: 'observe', summary: `Pool opened from the organiser's message. Sourced ${pool.offers.length} offers; picked ${pool.offers[0]?.merchant}.`, decision: 'info', checks: [] });
    await putPool(pool);
    out.push(pool);
  }
  return out;
}
