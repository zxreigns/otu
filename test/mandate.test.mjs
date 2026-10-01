import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, quote, shareFor, settlementPlan } from '../lib/pool.js';
import { validate, balanceCents } from '../lib/mandate.js';
import { splitEven, splitWeighted } from '../lib/money.js';
import { packSizeFromTitle, sourceOffers } from '../lib/sourcing.js';
import { ruleSpec } from '../lib/llm.js';
import { demoPay, tick, approve, decline } from '../lib/agent.js';

const env = {}; // no keys: simulated PayPal, catalog sourcing, rules-based thinking

async function demoPool(over = {}) {
  const spec = { title: 'Rice', item: 'jasmine rice', query: 'jasmine rice', unit: 'lb', qtyPerHousehold: 8, households: 6, capPerMemberCents: 1400, minMembers: 4, deadline: new Date(Date.now() + 86400e3).toISOString(), ...over };
  const { offers } = await sourceOffers(spec, env);
  const members = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, spec.households).map((n) => ({ name: n, email: n + '@x.test' }));
  return createPool({ spec, offers, members });
}

test('money splits are exact to the cent', () => {
  assert.deepEqual(splitEven(1000, 3), [334, 333, 333]);
  assert.equal(splitWeighted(1001, [1, 1, 2]).reduce((a, b) => a + b), 1001);
});

test('pack sizes parse from real titles', () => {
  assert.equal(packSizeFromTitle('Royal Thai Jasmine Rice, 50 lb Bag', 'lb'), 50);
  assert.equal(packSizeFromTitle('Kirkland Signature Diapers Size 3, 198 count', 'ct'), 198);
  assert.equal(Math.round(packSizeFromTitle('Rice 10 kg sack', 'lb')), 22);
  assert.equal(packSizeFromTitle('Tide pods pack of 42', 'ct'), 42);
});

test('rules parser reads a plain request', () => {
  const s = ruleSpec('5 households want rice, 10 lb each, nobody pays more than $15, close friday');
  assert.equal(s.households, 5); assert.equal(s.unit, 'lb'); assert.equal(s.qtyPerHousehold, 10); assert.equal(s.capPerMember, 15);
});

test('shares never exceed the cap and the chosen offer is viable', async () => {
  const p = await demoPool();
  const chosen = p.offers.find((o) => o.id === p.chosenOfferId);
  assert.ok(chosen.viable);
  for (const m of p.members) assert.ok(m.shareCents <= p.mandate.capPerMemberCents);
  assert.ok(chosen.quote.savingsPct > 0, 'bulk should beat buying alone');
});

test('mandate blocks over-cap, double pay, and pay after deadline', async () => {
  const p = await demoPool();
  const m = p.members[0];
  assert.equal(validate(p, { kind: 'collect', memberId: m.id, amountCents: 99999 }).allowed, false);
  await demoPay(p, m.id, env);
  const again = validate(p, { kind: 'collect', memberId: m.id, amountCents: m.shareCents });
  assert.equal(again.allowed, false);
  assert.ok(again.checks.find((c) => c.rule === 'not_already_paid' && !c.ok));
  const late = validate(p, { kind: 'collect', memberId: p.members[1].id, amountCents: p.members[1].shareCents }, Date.now() + 2 * 86400e3);
  assert.ok(late.checks.find((c) => c.rule === 'deadline' && !c.ok));
});

test('purchase needs approval, then settles and returns the surplus exactly', async () => {
  const p = await demoPool();
  for (const m of p.members) await demoPay(p, m.id, env);
  assert.equal(p.status, 'filled');
  await tick(p, env);
  assert.equal(p.status, 'awaiting_approval');
  assert.ok(p.pendingApproval.amountCents <= balanceCents(p));
  const unapproved = validate(p, { kind: 'purchase', offerId: p.pendingApproval.offerId, amountCents: p.pendingApproval.amountCents });
  assert.equal(unapproved.allowed, false); assert.equal(unapproved.needsApproval, true);
  const collected = balanceCents(p);
  const r = await approve(p, env, 'organiser');
  assert.equal(r.ok, true);
  assert.equal(p.status, 'settled');
  const spent = p.ledger.filter((l) => l.type === 'purchase').reduce((a, l) => a + l.amountCents, 0);
  const back = p.ledger.filter((l) => l.type === 'refund').reduce((a, l) => a + l.amountCents, 0);
  assert.equal(collected, spent + back + balanceCents(p));
  assert.ok(balanceCents(p) >= 0 && balanceCents(p) < p.members.length, 'at most rounding cents left');
});

test('price drift above the mandate blocks the purchase', async () => {
  const p = await demoPool();
  for (const m of p.members) await demoPay(p, m.id, { });
  await tick(p, { DEMO_PRICE_WOBBLE_PCT: 12 });
  const last = p.actions[p.actions.length - 1];
  // either another viable offer was picked, or the purchase was blocked on drift
  assert.ok(p.status === 'awaiting_approval' ? p.pendingApproval.checks.every((c) => c.ok) : last.checks.some((c) => c.rule === 'price_drift' && !c.ok));
});

test('a pool below minimum at the deadline refunds everyone in full', async () => {
  const p = await demoPool({ deadline: new Date(Date.now() + 1000).toISOString() });
  await demoPay(p, p.members[0].id, env);
  await demoPay(p, p.members[1].id, env);
  await new Promise((r) => setTimeout(r, 1100));
  await tick(p, env);
  assert.equal(p.status, 'refunded');
  assert.equal(balanceCents(p), 0);
});

test('decline refunds everyone', async () => {
  const p = await demoPool();
  for (const m of p.members) await demoPay(p, m.id, env);
  await tick(p, env);
  await decline(p, env);
  assert.equal(p.status, 'refunded');
  assert.equal(balanceCents(p), 0);
});

test('reminders respect budget and spacing', async () => {
  const p = await demoPool();
  await tick(p, env, { force: true });
  const unpaid = p.members.filter((m) => m.status !== 'paid');
  assert.ok(unpaid.every((m) => m.reminders.length === 1));
  await tick(p, env, { force: true });
  assert.ok(unpaid.every((m) => m.reminders.length === 1), 'spacing rule holds a second reminder back');
});
