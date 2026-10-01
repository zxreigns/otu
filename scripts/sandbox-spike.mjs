// One green sandbox transaction per PayPal surface Otu uses.
// PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/sandbox-spike.mjs
import { paypal } from '../lib/paypal.js';
const pp = paypal(process.env);
const out = { mode: pp.mode };
const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: e.message, body: e.body?.details || e.body }; } };
await step('order_create', () => pp.createOrder({ amountCents: 755, description: 'Otu spike share', referenceId: 'm_spike', customId: 'p_spike', requestId: 'spike-' + Date.now() }));
let cap;
await step('card_capture', async () => (cap = await pp.payWithTestCard({ amountCents: 755, referenceId: 'm_spike2', customId: 'p_spike', description: 'Otu spike card', name: 'Funmi Adeyemi', requestId: 'spikecard-' + Date.now() })));
await step('refund', () => (cap?.captureId ? pp.refundCapture(cap.captureId, 37, 'Otu spike: surplus back', { requestId: 'spikeref-' + Date.now() }) : Promise.reject(new Error('no capture'))));
let inv;
await step('invoice_create', async () => (inv = await pp.createInvoice({ recipientEmail: process.env.SPIKE_BUYER || 'buyer@example.com', recipientName: 'Chidi Okafor', amountCents: 755, itemName: 'Jasmine rice share', note: 'Your share for the group buy', dueDate: new Date(Date.now() + 3 * 864e5).toISOString(), invoicerEmail: process.env.PAYPAL_INVOICER_EMAIL })));
await step('invoice_send', () => pp.sendInvoice(inv.id));
await step('invoice_remind', () => pp.remindInvoice(inv.id, { subject: 'Quick nudge', note: '4 of 6 are in' }));
await step('payout', () => pp.payout([{ email: process.env.PAYPAL_SUPPLIER_EMAIL, amountCents: 100, note: 'Otu spike supplier', senderItemId: 'spike-item' }], { batchId: 'spike-' + Date.now(), subject: 'Otu spike' }));
console.log(JSON.stringify(out, null, 1));
