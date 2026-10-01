// PayPal layer. SANDBOX ONLY: this module refuses to talk to live PayPal.
//
// With PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET set it calls the real sandbox
// REST APIs (Orders v2, Payments v2 refunds, Invoicing v2, Payouts v1,
// Webhooks). Without them it runs a faithful simulator with the same method
// signatures, and every record it returns is marked mode:"simulated".

import { value } from './money.js';

const SANDBOX = 'https://api-m.sandbox.paypal.com';

export function paypalMode(env = process.env) {
  if ((env.PAYPAL_ENV || 'sandbox') !== 'sandbox') throw new Error('Otu only runs against the PayPal sandbox.');
  return env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET ? 'sandbox' : 'simulated';
}

let tokenCache = { token: null, exp: 0, id: null };

async function accessToken(env) {
  if (tokenCache.token && tokenCache.id === env.PAYPAL_CLIENT_ID && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const r = await fetch(`${SANDBOX}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (!r.ok) throw new PayPalError('oauth', r.status, j);
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000, id: env.PAYPAL_CLIENT_ID };
  return j.access_token;
}

export class PayPalError extends Error {
  constructor(op, status, body) {
    super(`PayPal ${op} failed (${status}): ${body?.message || body?.error_description || body?.name || 'error'}${body?.details?.[0]?.issue ? ' / ' + body.details[0].issue : ''}`);
    this.op = op; this.status = status; this.body = body;
  }
}

async function call(env, op, method, path, body, { requestId, prefer = 'return=representation' } = {}) {
  const token = await accessToken(env);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', prefer };
  if (requestId) headers['PayPal-Request-Id'] = requestId; // idempotency: a retried money call never doubles
  const r = await fetch(SANDBOX + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) throw new PayPalError(op, r.status, j);
  return { ...j, debugId: r.headers.get('paypal-debug-id') };
}

const simId = (p) => `SIM-${p}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

export function paypal(env = process.env) {
  const mode = paypalMode(env);
  const cur = env.CURRENCY || 'USD';

  if (mode === 'simulated') {
    return {
      mode,
      clientId: null,
      async createOrder({ amountCents, description, referenceId, customId }) {
        return { id: simId('ORDER'), status: 'CREATED', amountCents, description, referenceId, customId, mode };
      },
      async captureOrder(orderId) {
        return { id: orderId, status: 'COMPLETED', captureId: simId('CAPTURE'), payerEmail: null, mode };
      },
      async payWithTestCard({ amountCents, referenceId, customId, name }) {
        return { id: simId('ORDER'), status: 'COMPLETED', captureId: simId('CAPTURE'), amountCents, referenceId, customId, payerName: name, mode };
      },
      async refundCapture(captureId, amountCents, note) {
        return { id: simId('REFUND'), status: 'COMPLETED', captureId, amountCents, note, mode };
      },
      async payout(items, { batchId, subject }) {
        return { batchId: simId('PAYOUT'), status: 'SUCCESS', items: items.map((i) => ({ ...i, itemId: simId('ITEM'), status: 'SUCCESS' })), subject, mode };
      },
      async createInvoice({ recipientEmail, recipientName, amountCents, itemName, note, dueDate }) {
        const id = simId('INV');
        return { id, status: 'DRAFT', recipientEmail, amountCents, itemName, note, dueDate, mode, payLink: null };
      },
      async sendInvoice(id) { return { id, status: 'SENT', mode }; },
      async remindInvoice(id, { subject, note }) { return { id, status: 'REMINDED', subject, note, mode }; },
      async invoiceQr() { return null; },
      async verifyWebhook() { return false; },
    };
  }

  return {
    mode,
    clientId: env.PAYPAL_CLIENT_ID,

    // Orders v2 — a member's share. The buyer approves in PayPal Checkout (JS SDK);
    // the server captures. reference_id = member, custom_id = pool.
    async createOrder({ amountCents, description, referenceId, customId, requestId }) {
      const j = await call(env, 'orders.create', 'POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: referenceId, custom_id: customId, description: description?.slice(0, 127), amount: { currency_code: cur, value: value(amountCents) }, soft_descriptor: 'OTU GROUP BUY' }],
        application_context: { brand_name: 'Otu', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' },
      }, { requestId });
      return { id: j.id, status: j.status, mode, debugId: j.debugId };
    },

    async captureOrder(orderId, { requestId } = {}) {
      const j = await call(env, 'orders.capture', 'POST', `/v2/checkout/orders/${orderId}/capture`, {}, { requestId: requestId || `cap-${orderId}` });
      const cap = j.purchase_units?.[0]?.payments?.captures?.[0];
      return { id: j.id, status: j.status, captureId: cap?.id, captureStatus: cap?.status, payerEmail: j.payer?.email_address, payerName: [j.payer?.name?.given_name, j.payer?.name?.surname].filter(Boolean).join(' '), mode, debugId: j.debugId };
    },

    // Orders v2 with a sandbox test card, created + captured server-side.
    // Used by the demo crowd so a full pool can fill on camera.
    async payWithTestCard({ amountCents, referenceId, customId, description, name, requestId }) {
      const j = await call(env, 'orders.create(card)', 'POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: referenceId, custom_id: customId, description: description?.slice(0, 127), amount: { currency_code: cur, value: value(amountCents) } }],
        payment_source: { card: { number: env.PAYPAL_TEST_CARD || '4032035809742661', expiry: env.PAYPAL_TEST_CARD_EXPIRY || '2030-12', security_code: '123', name: name || 'Test Member' } },
      }, { requestId });
      let captureId = j.purchase_units?.[0]?.payments?.captures?.[0]?.id;
      let status = j.status;
      if (!captureId && j.status === 'APPROVED') {
        const c = await this.captureOrder(j.id);
        captureId = c.captureId; status = c.status;
      }
      return { id: j.id, status, captureId, mode, debugId: j.debugId };
    },

    // Payments v2 — the surplus goes back to the capture it came from.
    async refundCapture(captureId, amountCents, note, { requestId } = {}) {
      const j = await call(env, 'captures.refund', 'POST', `/v2/payments/captures/${captureId}/refund`, {
        amount: { currency_code: cur, value: value(amountCents) },
        note_to_payer: note?.slice(0, 255),
      }, { requestId });
      return { id: j.id, status: j.status, captureId, amountCents, mode, debugId: j.debugId };
    },

    // Payouts v1 — the supplier settlement (and the surplus route when a capture can't be refunded).
    async payout(items, { batchId, subject, note }) {
      const j = await call(env, 'payouts.create', 'POST', '/v1/payments/payouts', {
        sender_batch_header: { sender_batch_id: batchId, email_subject: subject, email_message: note },
        items: items.map((i) => ({ recipient_type: 'EMAIL', receiver: i.email, note: i.note, sender_item_id: i.senderItemId, amount: { currency: cur, value: value(i.amountCents) } })),
      }, { prefer: 'return=minimal' });
      return { batchId: j.batch_header?.payout_batch_id, status: j.batch_header?.batch_status, items, mode, debugId: j.debugId };
    },

    // Invoicing v2 — a late member gets a real PayPal invoice they can pay from email or QR.
    async createInvoice({ recipientEmail, recipientName, amountCents, itemName, note, dueDate, invoicerEmail }) {
      const body = {
        detail: { currency_code: cur, note: note?.slice(0, 4000), terms_and_conditions: 'Your share of a group buy run by Otu. Anything not spent comes back to you automatically.', payment_term: dueDate ? { due_date: dueDate.slice(0, 10) } : undefined },
        invoicer: invoicerEmail ? { email_address: invoicerEmail, business_name: 'Otu group buy' } : { business_name: 'Otu group buy' },
        primary_recipients: [{ billing_info: { email_address: recipientEmail, name: recipientName ? { full_name: recipientName } : undefined } }],
        items: [{ name: itemName.slice(0, 200), quantity: '1', unit_amount: { currency_code: cur, value: value(amountCents) }, unit_of_measure: 'AMOUNT' }],
      };
      const j = await call(env, 'invoices.create', 'POST', '/v2/invoicing/invoices', body);
      const id = j.id || (j.href || '').split('/').pop();
      return { id, status: j.status || 'DRAFT', mode, debugId: j.debugId };
    },
    async sendInvoice(id) {
      const j = await call(env, 'invoices.send', 'POST', `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: false, send_to_recipient: true }, { requestId: `send-${id}` });
      return { id, status: 'SENT', payLink: j.href || null, mode };
    },
    async remindInvoice(id, { subject, note }) {
      await call(env, 'invoices.remind', 'POST', `/v2/invoicing/invoices/${id}/remind`, { subject: subject?.slice(0, 4000), note: note?.slice(0, 4000), send_to_invoicer: false }, { prefer: 'return=minimal' });
      return { id, status: 'REMINDED', mode };
    },
    async invoiceQr(id) {
      const token = await accessToken(env);
      const r = await fetch(`${SANDBOX}/v2/invoicing/invoices/${id}/generate-qr-code`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ width: 300, height: 300, action: 'pay' }) });
      return r.ok ? await r.text() : null;
    },

    // Webhooks — PayPal tells us what actually happened; the ledger follows PayPal, not our guesses.
    async verifyWebhook(headers, rawBody) {
      if (!env.PAYPAL_WEBHOOK_ID) return false;
      const j = await call(env, 'webhooks.verify', 'POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: env.PAYPAL_WEBHOOK_ID,
        webhook_event: JSON.parse(rawBody),
      });
      return j.verification_status === 'SUCCESS';
    },
  };
}
