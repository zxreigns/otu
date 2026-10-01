// The agent loop: observe the pool, decide, ask the mandate, act through
// PayPal, write down what happened. Every money step goes through act().

import { validate, paidMembers, balanceCents, memberPaidCents } from './mandate.js';
import { quote, settlementPlan, failurePlan, uid, rankOffers } from './pool.js';
import { paypal } from './paypal.js';
import { requote } from './sourcing.js';
import { writeReminder, explainChoice } from './llm.js';
import { fmt } from './money.js';

const now = () => Date.now();
const iso = (t = now()) => new Date(t).toISOString();

function logAction(pool, { actor = 'agent', kind, summary, verdict, reasoning, provider, result, error }) {
  const entry = { id: uid('a_'), at: iso(), actor, kind, summary, decision: verdict ? (verdict.allowed ? 'allowed' : verdict.needsApproval ? 'needs_approval' : 'blocked') : 'info', checks: verdict?.checks || [], reasoning: reasoning || null, provider: provider || null, result: result || null, error: error || null };
  pool.actions.push(entry);
  return entry;
}

function ledger(pool, row) {
  const r = { id: uid('l_'), at: iso(), status: 'completed', ...row };
  pool.ledger.push(r);
  return r;
}

const memberOf = (pool, id) => pool.members.find((m) => m.id === id);

// ---- pay-in --------------------------------------------------------------

export async function createMemberOrder(pool, memberId, env) {
  const member = memberOf(pool, memberId);
  const action = { kind: 'collect', memberId, amountCents: member?.shareCents || 0 };
  const verdict = validate(pool, action, now());
  if (!verdict.allowed) {
    logAction(pool, { actor: 'member', kind: 'collect', summary: `${member?.name || memberId} tried to pay`, verdict });
    return { ok: false, verdict };
  }
  const pp = paypal(env);
  const order = await pp.createOrder({ amountCents: member.shareCents, description: `${pool.title} — share for ${member.name}`, referenceId: member.id, customId: pool.id, requestId: `ord-${pool.id}-${member.id}-${Date.now()}` });
  member.pendingOrderId = order.id;
  logAction(pool, { actor: 'member', kind: 'collect', summary: `${member.name} opened PayPal checkout for ${fmt(member.shareCents)}`, verdict, result: { orderId: order.id, mode: order.mode } });
  return { ok: true, orderId: order.id, mode: order.mode };
}

export async function captureMemberOrder(pool, memberId, orderId, env) {
  const member = memberOf(pool, memberId);
  if (!member || member.pendingOrderId !== orderId) return { ok: false, error: 'order does not belong to this member' };
  const verdict = validate(pool, { kind: 'collect', memberId, amountCents: member.shareCents }, now());
  if (!verdict.allowed) { logAction(pool, { actor: 'member', kind: 'collect', summary: `capture refused for ${member.name}`, verdict }); return { ok: false, verdict }; }
  const pp = paypal(env);
  const cap = await pp.captureOrder(orderId);
  if (cap.status !== 'COMPLETED') return { ok: false, error: `PayPal says ${cap.status}` };
  recordPayIn(pool, member, { orderId, captureId: cap.captureId, mode: cap.mode, via: 'PayPal Checkout', payer: cap.payerEmail });
  return { ok: true, captureId: cap.captureId };
}

export async function demoPay(pool, memberId, env) {
  const member = memberOf(pool, memberId);
  const verdict = validate(pool, { kind: 'collect', memberId, amountCents: member?.shareCents || 0 }, now());
  if (!verdict.allowed) { logAction(pool, { actor: 'member', kind: 'collect', summary: `${member?.name || memberId} payment refused`, verdict }); return { ok: false, verdict }; }
  const pp = paypal(env);
  const r = await pp.payWithTestCard({ amountCents: member.shareCents, referenceId: member.id, customId: pool.id, description: `${pool.title} — ${member.name}`, name: member.name, requestId: `demo-${pool.id}-${member.id}` });
  if (r.status !== 'COMPLETED') { logAction(pool, { actor: 'member', kind: 'collect', summary: `test-card payment for ${member.name} came back ${r.status}`, verdict, error: r.status }); return { ok: false, error: r.status }; }
  recordPayIn(pool, member, { orderId: r.id, captureId: r.captureId, mode: r.mode, via: 'sandbox test card' });
  return { ok: true };
}

// A late member paid their PayPal invoice (INVOICING.INVOICE.PAID webhook).
export async function payInFromInvoice(pool, member, invoice) {
  if (member.paidAt) return { ok: true, already: true };
  const verdict = validate(pool, { kind: 'collect', memberId: member.id, amountCents: member.shareCents }, now());
  if (!verdict.allowed) { logAction(pool, { actor: 'member', kind: 'collect', summary: `${member.name} paid their invoice but the pool is no longer collecting; flagged for refund`, verdict }); return { ok: false, verdict }; }
  const txn = invoice?.payments?.transactions?.[0]?.payment_id || null;
  recordPayIn(pool, member, { orderId: invoice?.id, captureId: null, mode: 'sandbox', via: 'PayPal invoice' });
  member.invoiceTxn = txn;
  return { ok: true };
}

function recordPayIn(pool, member, { orderId, captureId, mode, via, payer }) {
  member.status = 'paid';
  member.paidAt = iso();
  member.orderId = orderId;
  member.captureId = captureId;
  member.pendingOrderId = null;
  ledger(pool, { type: 'pay_in', direction: 'in', memberId: member.id, who: member.name, amountCents: member.shareCents, paypal: { orderId, captureId, mode }, note: via + (payer ? ` (${payer})` : '') });
  logAction(pool, { actor: 'member', kind: 'collect', summary: `${member.name} paid ${fmt(member.shareCents)} via ${via}`, verdict: { allowed: true, checks: [] }, result: { orderId, captureId, mode } });
  const paid = paidMembers(pool).length;
  if (paid >= pool.spec.households && pool.status === 'collecting') {
    pool.status = 'filled';
    logAction(pool, { kind: 'observe', summary: `Pool filled: ${paid}/${pool.spec.households} households paid, ${fmt(balanceCents(pool))} held` });
  }
}

// ---- the loop -------------------------------------------------------------

export async function tick(pool, env, { force = false } = {}) {
  const t = now();
  const done = [];
  if (pool.status === 'collecting') {
    const paid = paidMembers(pool).length;
    const deadline = pool.mandate.deadline ? Date.parse(pool.mandate.deadline) : Infinity;
    if (t >= deadline) {
      if (paid >= pool.mandate.minMembers) {
        pool.status = 'filled';
        logAction(pool, { kind: 'observe', summary: `Deadline reached with ${paid} paid (minimum ${pool.mandate.minMembers}): buying for the ${paid} households in` });
      } else {
        pool.status = 'failed';
        logAction(pool, { kind: 'observe', summary: `Deadline reached with only ${paid} of ${pool.mandate.minMembers} needed: refunding everyone in full` });
        done.push(...(await settle(pool, env, failurePlan(pool), 'Pool did not reach its minimum')));
        pool.status = 'refunded';
        return done;
      }
    } else {
      // remind whoever is due
      const hoursLeft = (deadline - t) / 3.6e6;
      for (const m of pool.members.filter((x) => memberPaidCents(pool, x.id) === 0)) {
        const v = validate(pool, { kind: 'remind', memberId: m.id }, t);
        const age = (t - Date.parse(m.joinedAt)) / 3.6e6;
        if (!v.allowed || (!force && age < 6 && hoursLeft > 12)) continue;
        done.push(await remind(pool, m, env, hoursLeft, v));
      }
    }
  }
  if (pool.status === 'filled') done.push(await proposePurchase(pool, env));
  return done;
}

async function remind(pool, member, env, hoursLeft, verdict) {
  const nth = (member.reminders || []).length + 1;
  const msg = await writeReminder(env, { pool, member, hoursLeft, nth });
  const pp = paypal(env);
  let result;
  try {
    if (!member.invoiceId) {
      const inv = await pp.createInvoice({ recipientEmail: member.email || `${member.id}@example.com`, recipientName: member.name, amountCents: member.shareCents, itemName: `${pool.title} — your share`, note: msg.note, dueDate: pool.mandate.deadline, invoicerEmail: env.PAYPAL_INVOICER_EMAIL });
      await pp.sendInvoice(inv.id);
      member.invoiceId = inv.id;
      result = { invoiceId: inv.id, channel: 'PayPal invoice sent', mode: inv.mode };
    } else {
      await pp.remindInvoice(member.invoiceId, msg);
      result = { invoiceId: member.invoiceId, channel: 'PayPal invoice reminder', mode: pp.mode };
    }
  } catch (e) {
    result = { channel: 'failed', error: e.message };
  }
  member.reminders = [...(member.reminders || []), { at: iso(), subject: msg.subject, note: msg.note, ...result }];
  return logAction(pool, { kind: 'remind', summary: `Reminder #${nth} to ${member.name}: “${msg.note}”`, verdict, provider: msg.provider, result, error: result.error });
}

async function proposePurchase(pool, env) {
  const paid = paidMembers(pool).length;
  const wobble = Number(env.DEMO_PRICE_WOBBLE_PCT ?? 1.2);
  const fresh = [];
  for (const o of pool.offers.slice(0, 5)) fresh.push(await requote(o, env, o.id === pool.chosenOfferId ? wobble : 0));
  const ranked = rankOffers(fresh, { ...pool.spec, households: paid }, pool.mandate).map((o) => ({ ...o, totalCents: pool.offers.find((x) => x.id === o.id)?.totalCents ?? o.totalCents }));
  const best = ranked.find((o) => o.viable && o.quote.totalCents <= balanceCents(pool)) || ranked[0];
  const q = quote(best, paid, pool.spec.qtyPerHousehold);
  const quotedFor = quote(pool.offers.find((o) => o.id === best.id) || best, paid, pool.spec.qtyPerHousehold);
  const action = { kind: 'purchase', offerId: best.id, amountCents: q.totalCents };
  // drift is measured against what this offer cost when members paid
  const poolForCheck = { ...pool, offers: pool.offers.map((o) => (o.id === best.id ? { ...o, totalCents: quotedFor.totalCents } : o)) };
  const verdict = validate(poolForCheck, action, now());
  const why = await explainChoice(env, { spec: { ...pool.spec, households: paid }, ranked });
  if (verdict.needsApproval) {
    pool.status = 'awaiting_approval';
    pool.pendingApproval = { id: uid('ap_'), at: iso(), offerId: best.id, title: best.title, merchant: best.merchant, url: best.url, households: paid, quote: q, quotedCents: quotedFor.totalCents, amountCents: q.totalCents, balanceCents: balanceCents(pool), surplusCents: balanceCents(pool) - q.totalCents, rationale: why.rationale, checks: verdict.checks };
    return logAction(pool, { kind: 'purchase', summary: `Ready to buy: ${q.packs} × ${best.title} from ${best.merchant} for ${fmt(q.totalCents)}. Waiting for the organiser's OK.`, verdict, reasoning: why.rationale, provider: why.provider });
  }
  return logAction(pool, { kind: 'purchase', summary: `Purchase blocked by the mandate`, verdict, reasoning: why.rationale, provider: why.provider });
}

export async function approve(pool, env, by = 'organiser') {
  const ap = pool.pendingApproval;
  if (!ap || pool.status !== 'awaiting_approval') return { ok: false, error: 'nothing waiting for approval' };
  const action = { kind: 'purchase', offerId: ap.offerId, amountCents: ap.amountCents, approval: { by, at: iso() } };
  const poolForCheck = { ...pool, offers: pool.offers.map((o) => (o.id === ap.offerId ? { ...o, totalCents: ap.quotedCents } : o)) };
  const verdict = validate(poolForCheck, action, now());
  if (!verdict.allowed) { logAction(pool, { actor: by, kind: 'purchase', summary: 'Approval given but the mandate blocked the purchase', verdict }); return { ok: false, verdict }; }
  const pp = paypal(env);
  let res;
  try {
    res = await pp.payout([{ email: env.PAYPAL_SUPPLIER_EMAIL || 'supplier@example.com', amountCents: ap.amountCents, note: `${ap.quote.packs} × ${ap.title} for pool ${pool.id}`, senderItemId: `buy-${pool.id}` }], { batchId: `buy-${pool.id}`, subject: `Order: ${ap.title}`, note: `Group order from Otu pool ${pool.title}` });
  } catch (e) {
    logAction(pool, { actor: by, kind: 'purchase', summary: `Supplier payment failed: ${e.message}`, verdict, error: e.message });
    return { ok: false, error: e.message };
  }
  ledger(pool, { type: 'purchase', direction: 'out', who: ap.merchant, amountCents: ap.amountCents, paypal: { payoutBatchId: res.batchId, status: res.status, mode: res.mode }, note: `${ap.quote.packs} × ${ap.title}` });
  logAction(pool, { actor: by, kind: 'purchase', summary: `Approved by ${by}. Paid ${ap.merchant} ${fmt(ap.amountCents)} for ${ap.quote.packs} × ${ap.title}`, verdict, result: { payoutBatchId: res.batchId, mode: res.mode } });
  pool.status = 'purchased';
  pool.purchase = { ...ap, approvedBy: by, approvedAt: iso(), payoutBatchId: res.batchId };
  pool.pendingApproval = null;
  const plan = settlementPlan(pool, ap.amountCents);
  pool.settlement = { plan, at: iso() };
  await settle(pool, env, plan, `What's left from ${pool.title}`);
  pool.status = 'settled';
  logAction(pool, { kind: 'observe', summary: `Settled: ${plan.filter((p) => p.backCents > 0).length} members got ${fmt(plan.reduce((a, p) => a + p.backCents, 0))} back. Pool balance ${fmt(balanceCents(pool))}.` });
  return { ok: true };
}

export async function decline(pool, env, by = 'organiser') {
  if (pool.status !== 'awaiting_approval') return { ok: false, error: 'nothing waiting for approval' };
  logAction(pool, { actor: by, kind: 'purchase', summary: `${by} declined the purchase; refunding everyone in full` });
  pool.pendingApproval = null;
  pool.status = 'failed';
  await settle(pool, env, failurePlan(pool), `${pool.title} was cancelled`);
  pool.status = 'refunded';
  return { ok: true };
}

async function settle(pool, env, plan, note) {
  const pp = paypal(env);
  const out = [];
  for (const p of plan.filter((x) => x.backCents > 0)) {
    const member = memberOf(pool, p.memberId);
    const route = pool.mandate.surplusRoute === 'payout' || !member.captureId ? 'payout' : 'refund';
    const action = { kind: route, memberId: member.id, amountCents: p.backCents, owedCents: p.backCents, route };
    const verdict = validate(pool, action, now());
    if (!verdict.allowed) { out.push(logAction(pool, { kind: route, summary: `Return to ${member.name} blocked`, verdict })); continue; }
    try {
      let ref;
      if (route === 'refund') ref = await pp.refundCapture(member.captureId, p.backCents, `${note}: ${fmt(p.backCents)} back to you.`, { requestId: `ref-${pool.id}-${member.id}`, customId: pool.id });
      else ref = await pp.payout([{ email: member.email, amountCents: p.backCents, note, senderItemId: `back-${pool.id}-${member.id}` }], { batchId: `back-${pool.id}-${member.id}`, subject: note });
      ledger(pool, { type: route, direction: 'out', memberId: member.id, who: member.name, amountCents: p.backCents, paypal: { refundId: ref.id, payoutBatchId: ref.batchId, status: ref.status, mode: ref.mode }, note });
      member.status = p.costCents ? 'settled' : 'refunded';
      member.backCents = (member.backCents || 0) + p.backCents;
      out.push(logAction(pool, { kind: route, summary: `${fmt(p.backCents)} back to ${member.name} (${route === 'refund' ? 'refund to their original PayPal payment' : 'PayPal payout'})`, verdict, result: { id: ref.id || ref.batchId, mode: ref.mode } }));
    } catch (e) {
      out.push(logAction(pool, { kind: route, summary: `Return to ${member.name} failed: ${e.message}`, verdict, error: e.message }));
    }
  }
  return out;
}
