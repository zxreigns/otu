// The mandate engine.
//
// The agent is allowed to *propose* anything. Nothing touches money unless the
// proposal passes every rule here. The engine is deterministic and pure: same
// pool + same action + same clock => same verdict. It never calls a model.
//
// verdict = { allowed, needsApproval, checks: [{ rule, ok, detail }] }

import { fmt } from './money.js';

export const DEFAULT_MANDATE = {
  capPerMemberCents: 2000,      // nobody pays more than this, ever
  maxTotalCents: null,          // optional hard ceiling for the whole pool
  minMembers: 3,                // the buy only happens with at least this many paid members
  deadline: null,               // ISO; after it, no new pay-ins and an unfilled pool refunds
  maxPriceDriftPct: 5,          // re-quoted price may rise at most this much over the quote members paid against
  allowedMerchants: [],         // empty = any merchant the agent sourced; else domain allowlist
  approvalRequiredFor: ['purchase'],
  maxRemindersPerMember: 3,
  minHoursBetweenReminders: 12,
  surplusRoute: 'refund',       // 'refund' (back to the original capture) | 'payout'
};

const check = (rule, ok, detail) => ({ rule, ok: !!ok, detail });

export function paidMembers(pool) {
  return pool.members.filter((m) => memberPaidCents(pool, m.id) > 0);
}
export function collectedCents(pool) {
  return pool.ledger.filter((l) => l.type === 'pay_in' && l.status === 'completed').reduce((a, l) => a + l.amountCents, 0);
}
export function spentCents(pool) {
  return pool.ledger.filter((l) => l.type === 'purchase' && l.status !== 'failed').reduce((a, l) => a + l.amountCents, 0);
}
export function returnedCents(pool) {
  return pool.ledger.filter((l) => (l.type === 'refund' || l.type === 'payout') && l.status !== 'failed').reduce((a, l) => a + l.amountCents, 0);
}
export function balanceCents(pool) {
  return collectedCents(pool) - spentCents(pool) - returnedCents(pool);
}
export function memberPaidCents(pool, memberId) {
  return pool.ledger.filter((l) => l.memberId === memberId && l.type === 'pay_in' && l.status === 'completed').reduce((a, l) => a + l.amountCents, 0);
}
export function memberReturnedCents(pool, memberId) {
  return pool.ledger.filter((l) => l.memberId === memberId && (l.type === 'refund' || l.type === 'payout') && l.status !== 'failed').reduce((a, l) => a + l.amountCents, 0);
}

function beforeDeadline(m, now) {
  if (!m.deadline) return check('deadline', true, 'no deadline set');
  const ok = now < Date.parse(m.deadline);
  return check('deadline', ok, ok ? `open until ${m.deadline}` : `deadline ${m.deadline} has passed`);
}

// ---- rules per action kind -------------------------------------------------

const RULES = {
  collect(pool, a, now) {
    const m = pool.mandate;
    const member = pool.members.find((x) => x.id === a.memberId);
    const out = [];
    out.push(check('pool_open', pool.status === 'collecting', `pool status is ${pool.status}`));
    out.push(beforeDeadline(m, now));
    out.push(check('known_member', !!member, member ? `${member.name} is on the roster` : `member ${a.memberId} is not on the roster`));
    if (member) out.push(check('not_already_paid', memberPaidCents(pool, member.id) === 0, memberPaidCents(pool, member.id) ? `${member.name} already paid` : 'first payment for this member'));
    out.push(check('positive_amount', a.amountCents > 0, `amount ${fmt(a.amountCents)}`));
    out.push(check('member_cap', a.amountCents <= m.capPerMemberCents, `${fmt(a.amountCents)} vs cap ${fmt(m.capPerMemberCents)}`));
    if (member) out.push(check('matches_share', a.amountCents === member.shareCents, `share is ${fmt(member.shareCents)}`));
    if (m.maxTotalCents) out.push(check('pool_ceiling', collectedCents(pool) + a.amountCents <= m.maxTotalCents, `would bring pool to ${fmt(collectedCents(pool) + a.amountCents)} of max ${fmt(m.maxTotalCents)}`));
    return { checks: out };
  },

  remind(pool, a, now) {
    const m = pool.mandate;
    const member = pool.members.find((x) => x.id === a.memberId);
    const out = [];
    out.push(check('pool_open', pool.status === 'collecting', `pool status is ${pool.status}`));
    out.push(beforeDeadline(m, now));
    out.push(check('known_member', !!member, member ? member.name : 'unknown member'));
    if (member) {
      out.push(check('still_unpaid', memberPaidCents(pool, member.id) === 0, memberPaidCents(pool, member.id) ? 'already paid' : 'has not paid'));
      const sent = (member.reminders || []);
      out.push(check('reminder_budget', sent.length < m.maxRemindersPerMember, `${sent.length} of ${m.maxRemindersPerMember} reminders used`));
      const last = sent.length ? Date.parse(sent[sent.length - 1].at) : 0;
      const hours = (now - last) / 3.6e6;
      out.push(check('reminder_spacing', !last || hours >= m.minHoursBetweenReminders, last ? `last reminder ${hours.toFixed(1)} h ago (min ${m.minHoursBetweenReminders} h)` : 'no earlier reminder'));
    }
    return { checks: out };
  },

  purchase(pool, a) {
    const m = pool.mandate;
    const offer = (pool.offers || []).find((o) => o.id === a.offerId);
    const paid = paidMembers(pool).length;
    const bal = balanceCents(pool);
    const out = [];
    out.push(check('pool_filled', ['filled', 'awaiting_approval'].includes(pool.status), `pool status is ${pool.status}`));
    out.push(check('min_members', paid >= m.minMembers, `${paid} paid of ${m.minMembers} required`));
    out.push(check('offer_known', !!offer, offer ? `${offer.title} @ ${offer.merchant}` : 'offer not in the sourced list'));
    out.push(check('funds_cover', a.amountCents <= bal, `${fmt(a.amountCents)} vs ${fmt(bal)} held`));
    if (offer) {
      const allow = m.allowedMerchants || [];
      out.push(check('merchant_allowed', !allow.length || allow.includes(offer.merchantDomain), allow.length ? `${offer.merchantDomain} vs allowlist` : 'any sourced merchant allowed'));
      const quoted = offer.totalCents;
      const drift = quoted ? ((a.amountCents - quoted) / quoted) * 100 : 0;
      out.push(check('price_drift', drift <= m.maxPriceDriftPct, `live ${fmt(a.amountCents)} vs quoted ${fmt(quoted)} (${drift >= 0 ? '+' : ''}${drift.toFixed(1)}%, max +${m.maxPriceDriftPct}%)`));
      const perHead = paid ? Math.ceil(a.amountCents / paid) : Infinity;
      out.push(check('per_member_cost_under_cap', perHead <= m.capPerMemberCents, `${fmt(perHead)} per member vs cap ${fmt(m.capPerMemberCents)}`));
    }
    out.push(check('single_purchase', spentCents(pool) === 0, spentCents(pool) ? 'a purchase already went through' : 'no earlier purchase'));
    return { checks: out, needsApproval: (m.approvalRequiredFor || []).includes('purchase') };
  },

  refund(pool, a) {
    const member = pool.members.find((x) => x.id === a.memberId);
    const out = [];
    out.push(check('known_member', !!member, member ? member.name : 'unknown member'));
    out.push(check('positive_amount', a.amountCents > 0, fmt(a.amountCents)));
    if (member) {
      const paid = memberPaidCents(pool, member.id);
      const back = memberReturnedCents(pool, member.id);
      const owed = a.owedCents ?? paid; // what the plan says this member is owed back
      out.push(check('within_member_paid', back + a.amountCents <= paid, `${fmt(back + a.amountCents)} returned vs ${fmt(paid)} paid`));
      out.push(check('matches_plan', a.amountCents <= owed, `${fmt(a.amountCents)} vs ${fmt(owed)} owed`));
      out.push(check('has_capture', a.route !== 'refund' || !!member.captureId, member.captureId ? 'refund goes to the original PayPal capture' : 'no capture to refund against'));
    }
    out.push(check('funds_cover', a.amountCents <= balanceCents(pool), `${fmt(a.amountCents)} vs ${fmt(balanceCents(pool))} held`));
    out.push(check('pool_settling', ['purchased', 'settling', 'failed', 'refunding'].includes(pool.status), `pool status is ${pool.status}`));
    return { checks: out };
  },
};
RULES.payout = RULES.refund;

export function validate(pool, action, now = Date.now()) {
  const fn = RULES[action.kind];
  if (!fn) return { allowed: false, needsApproval: false, checks: [check('known_action', false, `unknown action ${action.kind}`)] };
  const { checks, needsApproval = false } = fn(pool, action, now);
  const allowed = checks.every((c) => c.ok);
  const approved = !needsApproval || (action.approval && action.approval.by && action.approval.at);
  return { allowed: allowed && !!approved, needsApproval: allowed && needsApproval && !approved, checks };
}

export function describeMandate(m) {
  return [
    `Nobody pays more than ${fmt(m.capPerMemberCents)}`,
    `Buy only with ${m.minMembers}+ paid members`,
    m.deadline ? `Closes ${new Date(m.deadline).toUTCString().slice(0, 22)} UTC` : 'No deadline',
    `Price may rise at most ${m.maxPriceDriftPct}% before the agent must ask again`,
    m.allowedMerchants?.length ? `Merchants: ${m.allowedMerchants.join(', ')}` : 'Any merchant the agent sourced',
    'The purchase waits for the organiser\'s approval',
    `Up to ${m.maxRemindersPerMember} reminders, ${m.minHoursBetweenReminders} h apart`,
  ];
}
