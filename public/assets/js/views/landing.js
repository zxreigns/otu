import { heroCanvas } from '../hero.js';
import { observeReveal, api, toast } from '../util.js';

export function landing(app, nav) {
  app.innerHTML = `
  <section class="hero">
    <canvas id="hero-c" aria-hidden="true"></canvas>
    <div class="wrap">
      <p class="eyebrow reveal">Group buying, run by an agent</p>
      <h1 class="reveal" data-delay="80">Buy as <em class="r">one.</em></h1>
      <p class="lede reveal" data-delay="160">Tell the agent what your group needs. It finds the bulk deal, collects every share through PayPal, buys when the pool fills, and pays back what's left. You approve the one thing that matters.</p>
      <div class="ctas reveal" data-delay="240">
        <a class="btn primary" href="/new" data-link>Start a pool <span class="arrow">→</span></a>
        <button class="btn ghost" id="demo-btn">Open a live demo pool</button>
      </div>
    </div>
  </section>

  <section class="block">
    <div class="wrap">
      <p class="eyebrow reveal">How it works</p>
      <h2 class="reveal" style="max-width:980px;margin-top:14px">Pay in <span class="chip pay"><i>P</i>PayPal</span>, buy once <span class="chip buy"><i>✓</i>your OK</span>, and get the rest back <span class="chip back"><i>↩</i>refunds</span>.</h2>
      <div class="grid3">
        <div class="card step reveal"><div class="glyph" data-g="in"></div><span class="n">01 · Orders v2</span><h3>Everyone pays their share</h3><p>Each member pays through PayPal Checkout. Late ones get a real PayPal invoice, with reminders the agent writes like a neighbour would.</p></div>
        <div class="card step reveal" data-delay="100"><div class="glyph" data-g="buy"></div><span class="n">02 · Mandate + approval</span><h3>One purchase, at the best price</h3><p>When the pool fills, the agent re-checks every offer, rescales the order to who actually paid, and asks you once before it spends.</p></div>
        <div class="card step reveal" data-delay="200"><div class="glyph" data-g="out"></div><span class="n">03 · Refunds + Payouts</span><h3>What's left goes home</h3><p>The buffer and any savings flow back to each member's original PayPal payment, to the cent, with a receipt trail for all of it.</p></div>
      </div>
    </div>
  </section>

  <section class="block dark">
    <div class="wrap split">
      <div>
        <p class="eyebrow reveal" style="color:#A9A296">The mandate</p>
        <h2 class="reveal" style="margin-top:14px">The agent proposes.<br><em class="r">The rules decide.</em></h2>
        <p class="lede reveal" style="margin-top:22px">The model reads messy requests, weighs offers and writes the reminders. It never touches money directly. Every pay-in, purchase and refund passes a deterministic rulebook first, and every verdict is on the record.</p>
      </div>
      <ul class="rules reveal" data-delay="120">
        <li><b>01</b>Nobody pays more than the cap the organiser set.</li>
        <li><b>02</b>No buy below the minimum number of paid members.</li>
        <li><b>03</b>If the price moved more than 5% since members paid, the agent has to ask again.</li>
        <li><b>04</b>The purchase waits for the organiser's approval.</li>
        <li><b>05</b>Refunds can never exceed what a member paid.</li>
        <li><b>06</b>Pool didn't fill by the deadline? Everyone gets everything back.</li>
      </ul>
    </div>
  </section>

  <section class="block">
    <div class="wrap split">
      <div>
        <p class="eyebrow reveal">Why</p>
        <h2 class="reveal" style="margin-top:14px">Neighbours already do this. With a spreadsheet.</h2>
      </div>
      <p class="lede reveal" data-delay="100">When food prices climb, people split bulk bags of rice, oil and beans between households. It works, and it runs on one tired organiser chasing transfers in a group chat. Otu gives that group an agent with a wallet and a rulebook.</p>
    </div>
  </section>

  <footer><div class="wrap"><span>Otu · PayPal sandbox only, no real money moves.</span><span>PayPal Orders · Invoicing · Refunds · Payouts · Webhooks</span></div></footer>`;

  const stop = heroCanvas(document.getElementById('hero-c'));
  observeReveal(app);
  drawGlyphs(app);
  document.getElementById('demo-btn').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Opening…';
    try { const p = await api('/demo/fresh', { method: 'POST' }); nav('/p/' + p.id); }
    catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = 'Open a live demo pool'; }
  };
  return stop;
}

function drawGlyphs(root) {
  root.querySelectorAll('.glyph').forEach((g) => {
    const kind = g.dataset.g;
    const dots = Array.from({ length: 6 }, (_, i) => i);
    const svg = kind === 'in'
      ? `<svg viewBox="0 0 300 120" width="100%" height="100%">${dots.map((i) => `<circle cx="${40 + i * 30}" cy="${30 + (i % 2) * 50}" r="6" fill="#121212"><animate attributeName="cx" values="${40 + i * 30};225;${40 + i * 30}" dur="4s" begin="${i * 0.25}s" repeatCount="indefinite"/><animate attributeName="cy" values="${30 + (i % 2) * 50};60;${30 + (i % 2) * 50}" dur="4s" begin="${i * 0.25}s" repeatCount="indefinite"/></circle>`).join('')}<circle cx="240" cy="60" r="26" fill="none" stroke="#2F5BFF" stroke-width="2"/></svg>`
      : kind === 'buy'
      ? `<svg viewBox="0 0 300 120" width="100%" height="100%"><circle cx="150" cy="60" r="34" fill="none" stroke="#121212" stroke-width="2"/><circle cx="150" cy="60" r="34" fill="none" stroke="#E8412F" stroke-width="4" stroke-dasharray="214" stroke-dashoffset="214"><animate attributeName="stroke-dashoffset" values="214;0;0" dur="3.5s" repeatCount="indefinite"/></circle><path d="M136 60l10 10 18-20" fill="none" stroke="#121212" stroke-width="3" stroke-linecap="round"/></svg>`
      : `<svg viewBox="0 0 300 120" width="100%" height="100%"><circle cx="70" cy="60" r="22" fill="#121212"/>${dots.map((i) => `<circle cx="70" cy="60" r="5" fill="#1E8A5A"><animate attributeName="cx" values="70;${150 + (i % 3) * 50}" dur="3s" begin="${i * 0.3}s" repeatCount="indefinite"/><animate attributeName="cy" values="60;${25 + Math.floor(i / 3) * 70}" dur="3s" begin="${i * 0.3}s" repeatCount="indefinite"/></circle>`).join('')}</svg>`;
    g.innerHTML = svg;
  });
}
