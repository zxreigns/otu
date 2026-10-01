// Pool maths and state. Pure functions; persistence lives in store.js.

import { DEFAULT_MANDATE, collectedCents, spentCents, balanceCents, paidMembers, memberPaidCents, memberReturnedCents } from './mandate.js';
import { splitEven } from './money.js';

export const STATUS = ['collecting', 'filled', 'awaiting_approval', 'purchased', 'settled', 'failed', 'refunded'];

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

// What an offer costs for `households` households wanting `qtyPerHousehold` units each.
export function quote(offer, households, qtyPerHousehold) {
  const units = households * qtyPerHousehold;
  const packs = Math.max(1, Math.ceil(units / offer.packSize));
  const goods = packs * offer.packPriceCents;
  const total = goods + (offer.shippingCents || 0);
  const unitCost = total / units;
  const aloneCost = qtyPerHousehold * (offer.retailUnitCents || offer.packPriceCents / offer.packSize);
  const perHousehold = Math.ceil(total / households);
  const savingsPct = aloneCost ? Math.max(0, Math.round((1 - perHousehold / aloneCost) * 1000) / 10) : 0;
  return { households, units, packs, goodsCents: goods, shippingCents: offer.shippingCents || 0, totalCents: total, unitCostCents: unitCost, perHouseholdCents: perHousehold, aloneCents: Math.round(aloneCost), savingsPct, leftoverUnits: packs * offer.packSize - units };
}

// Share each member pays up front: their slice of the quote plus a drift buffer,
// so a small price move at checkout never leaves the pool short. The buffer
// comes back to them at settlement.
export function shareFor(offerQuote, mandate) {
  const buffered = Math.ceil(offerQuote.perHouseholdCents * (1 + (mandate.maxPriceDriftPct || 0) / 100));
  return Math.min(Math.ceil(buffered / 5) * 5, mandate.capPerMemberCents); // round up to 5 cents, never over cap
}

export function rankOffers(offers, spec, mandate) {
  return offers
    .map((o) => {
      const q = quote(o, spec.households, spec.qtyPerHousehold);
      const viable = Math.ceil(q.perHouseholdCents * (1 + mandate.maxPriceDriftPct / 100)) <= mandate.capPerMemberCents;
      return { ...o, quote: q, totalCents: q.totalCents, viable };
    })
    .sort((a, b) => (b.viable - a.viable) || (a.quote.perHouseholdCents - b.quote.perHouseholdCents) || ((b.rating || 0) - (a.rating || 0)));
}

export function createPool({ spec, offers, organiser, request, members = [], now = Date.now(), mandate = {} }) {
  const m = { ...DEFAULT_MANDATE, ...mandate };
  if (spec.capPerMemberCents) m.capPerMemberCents = spec.capPerMemberCents;
  if (spec.minMembers) m.minMembers = spec.minMembers;
  if (spec.deadline) m.deadline = spec.deadline;
  const ranked = rankOffers(offers, spec, m);
  const chosen = ranked.find((o) => o.viable) || ranked[0];
  const share = chosen ? shareFor(chosen.quote, m) : 0;
  const pool = {
    id: uid('p_'),
    createdAt: new Date(now).toISOString(),
    title: spec.title || `${spec.item}`,
    request: request || '',
    organiser: organiser || { name: 'Organiser' },
    spec,
    mandate: m,
    offers: ranked,
    chosenOfferId: chosen?.id || null,
    members: [],
    ledger: [],
    actions: [],
    status: 'collecting',
    pendingApproval: null,
    settlement: null,
  };
  for (const mem of members) addMember(pool, mem, share);
  return pool;
}

export function addMember(pool, { name, email, sandbox = true }, shareCents) {
  const chosen = pool.offers.find((o) => o.id === pool.chosenOfferId);
  const share = shareCents ?? (chosen ? shareFor(chosen.quote, pool.mandate) : 0);
  const m = { id: uid('m_'), name, email: email || '', shareCents: share, status: 'invited', reminders: [], joinedAt: new Date().toISOString(), sandbox };
  pool.members.push(m);
  return m;
}

export function summary(pool) {
  const paid = paidMembers(pool);
  const target = pool.spec.households;
  const chosen = pool.offers.find((o) => o.id === pool.chosenOfferId);
  return {
    target,
    paid: paid.length,
    invited: pool.members.length,
    fillPct: target ? Math.min(100, Math.round((paid.length / target) * 100)) : 0,
    collectedCents: collectedCents(pool),
    spentCents: spentCents(pool),
    balanceCents: balanceCents(pool),
    returnedCents: pool.ledger.filter((l) => (l.type === 'refund' || l.type === 'payout') && l.status !== 'failed').reduce((a, l) => a + l.amountCents, 0),
    chosen: chosen ? { id: chosen.id, title: chosen.title, merchant: chosen.merchant, perHouseholdCents: chosen.quote.perHouseholdCents, aloneCents: chosen.quote.aloneCents, savingsPct: chosen.quote.savingsPct } : null,
    deadline: pool.mandate.deadline,
  };
}

// After the purchase: what each paid member actually owes and gets back.
export function settlementPlan(pool, purchaseCents) {
  const paid = paidMembers(pool);
  const costs = splitEven(purchaseCents, paid.length);
  return paid.map((m, i) => {
    const p = memberPaidCents(pool, m.id);
    const already = memberReturnedCents(pool, m.id);
    return { memberId: m.id, name: m.name, paidCents: p, costCents: costs[i], backCents: Math.max(0, p - costs[i] - already) };
  });
}

// Full refunds when the pool fails (deadline passed below minimum).
export function failurePlan(pool) {
  return paidMembers(pool).map((m) => ({ memberId: m.id, name: m.name, paidCents: memberPaidCents(pool, m.id), costCents: 0, backCents: memberPaidCents(pool, m.id) - memberReturnedCents(pool, m.id) }));
}

export function publicView(pool) {
  // Strip anything a member page shouldn't show (emails).
  const p = structuredClone(pool);
  p.members = p.members.map(({ email, ...rest }) => ({ ...rest, email: email ? email.replace(/(^.).*(@.*$)/, '$1•••$2') : '' }));
  return p;
}
