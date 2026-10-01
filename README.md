# Otu — buy as one

**An AI agent that runs a group buy end-to-end on PayPal: it sources the bulk deal, collects every member's share, chases the late ones, buys once when the pool fills, and pays back what's left — to the cent.**

> *Otu* is Igbo for "one".

Live demo: **https://otu.vercel.app** · PayPal **sandbox only**, no real money ever moves.

---

## The problem

When food prices climb, neighbours split bulk bags of rice, oil and beans between households. A 50 lb bag split six ways costs each family about a third less than buying a small bag alone. It works, and today it runs on one tired organiser, a group chat, a spreadsheet and a pile of transfers to chase.

## What Otu does

1. **The organiser just says what the group wants**: *"Six of us want jasmine rice, about 8 lb each. Close it Friday, nobody pays more than $14."*
2. **The agent drafts the pool**: it reads the request, sources offers across retailers, prices each one *per household* against what a family would pay buying alone, picks the best one and explains why.
3. **Members pay their share with PayPal** (Orders v2, PayPal Checkout). Each share carries a small buffer for price movement, which comes back later.
4. **Late members get a real PayPal invoice** (Invoicing v2) with a reminder the agent writes like a neighbour would, inside a reminder budget.
5. **When the pool fills, the agent re-checks prices**, rescales the order to the households that actually paid, and asks the organiser for **one approval**.
6. **It pays the supplier** (Payouts v1) and **refunds every member's surplus to their original PayPal payment** (Payments v2 refunds), exact to the cent.
7. If the pool doesn't reach its minimum by the deadline, **everyone gets everything back automatically**.

## The mandate: the agent proposes, the rules decide

The model never touches money directly. Every money action — pay-in, reminder, purchase, refund, payout — is validated by a deterministic, pure rule engine ([`lib/mandate.js`](lib/mandate.js)) before anything is sent to PayPal, and every verdict (with each rule's pass/fail and detail) lands in the pool's audit trail.

| Rule | What it enforces |
|---|---|
| `member_cap` | nobody pays more than the cap the organiser set |
| `matches_share`, `not_already_paid` | exact share, once |
| `deadline`, `pool_open` | no pay-ins after close |
| `min_members` | no purchase below the minimum paid members |
| `price_drift` | if the re-checked price rose more than 5% over what members paid against, the agent must ask again |
| `per_member_cost_under_cap` | the rescaled order still respects the cap |
| `funds_cover`, `single_purchase` | it can only spend what it holds, once |
| approval | the purchase waits for the organiser |
| `within_member_paid`, `matches_plan`, `has_capture` | refunds never exceed what a member paid, and go back to their own capture |
| `reminder_budget`, `reminder_spacing` | at most 3 reminders, 12 h apart |

All money is integer cents; splits use exact remainder distribution, so `collected = spent + returned + held` always balances (see the tests).

## PayPal integration

| PayPal API | Used for | Code |
|---|---|---|
| **Orders v2** + PayPal JS SDK Buttons | each member's pay-in (create on our server, buyer approves in PayPal, capture on our server) | `lib/paypal.js` `createOrder`, `captureOrder` |
| **Orders v2** with a sandbox test card | the "demo crowd" that fills a pool on camera with real sandbox captures | `payWithTestCard` |
| **Invoicing v2** | reminder invoices for late members: create, send, remind, QR | `createInvoice`, `sendInvoice`, `remindInvoice`, `invoiceQr` |
| **Payouts v1** | paying the supplier once the organiser approves; surplus route when a capture can't be refunded | `payout` |
| **Payments v2 refunds** | surplus back to each member's original capture | `refundCapture` |
| **Webhooks** | signature-verified events update the ledger | `verifyWebhook`, `/api/paypal/webhook` |

Every money call carries a `PayPal-Request-Id`, so a retried request can never double-charge or double-refund. The module refuses to run against live PayPal.

## AI

- **Request → pool spec**: the model turns a messy message into item, unit, quantity per household, households, cap, minimum and deadline (JSON mode).
- **Offer reasoning**: it explains the pick in plain words with the numbers.
- **Reminders**: short, warm, never guilt-tripping, escalating gently with each reminder.
- Providers: Google Gemini (`gemini-3.8-flash`) first, Groq second, deterministic rules as the last fallback, so the product keeps working with no keys at all. The provider used for each step is shown in the UI.

## Sponsor tools

- **AG Grid** — the organiser console (`/console`): pools, members, the full ledger and every mandate verdict in live grids (row ids + cell-change flashing as webhooks and pay-ins land, pinned total rows, custom renderers, quartz theme matched to the brand).
- **Channel3** — offer sourcing over its product graph (`POST /v1/search`), with pack sizes parsed from titles and the cheapest listing kept per retailer. Without a key, a curated catalog fixture answers through the same interface (clearly labelled in the UI).

## Run it

```bash
git clone https://github.com/zxreigns/otu && cd otu
cp .env.example .env   # optional: fill in sandbox keys
npm run dev            # http://localhost:8790  (zero dependencies)
npm test               # mandate, money and settlement tests
```

With no keys it runs fully: payments go through a built-in sandbox simulator (every record is marked `simulated`), sourcing uses the catalog and the agent uses rules. Add `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` from a PayPal **sandbox** app to switch every money step to the real sandbox APIs.

### Try the demo

1. Open **/** → **Open a live demo pool** (a fresh pool for six households).
2. **Run the agent** → unpaid members get PayPal invoices with written reminders.
3. Pay one share yourself with the PayPal button (sandbox buyer account), or tap **Demo: pay the other N**.
4. The pool fills → the agent re-checks prices → **Approve**.
5. Watch the supplier payout and the refunds land, then open **/console**.

## Layout

```
api/index.js        one zero-dependency Vercel function: the whole API
lib/mandate.js      the rule engine (pure, deterministic)
lib/pool.js         quoting, shares, settlement maths
lib/agent.js        the loop: observe → decide → validate → act → record
lib/paypal.js       PayPal sandbox REST client + simulator with the same interface
lib/sourcing.js     Channel3 adapter + catalog fixture
lib/llm.js          Gemini / Groq / rules
lib/store.js        Upstash Redis REST or memory
public/             the app (vanilla ES modules, AG Grid Community)
test/               node --test
```

## License

MIT
