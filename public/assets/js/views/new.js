import { api, esc, money, toast, $ } from '../util.js';

const EXAMPLES = [
  'Six of us on Adeyemi Close want jasmine rice, about 8 lb per household. Close it Friday, nobody pays more than $14.',
  '5 families splitting vegetable oil, 1 gal each, cap $12 per family, close in 3 days',
  '4 households want Tide pods, 38 count each, nobody pays more than $15',
  '8 parents splitting size 3 diapers, 50 count each, max $16 each, close this week',
];
const NEIGHBOURS = [['Funmi Adeyemi', 'funmi.adeyemi'], ['Chidi Okafor', 'chidi.okafor'], ['Tolu Bakare', 'tolu.bakare'], ['Amaka Eze', 'amaka.eze'], ['Ibrahim Musa', 'ibrahim.musa'], ['Grace Oyelaran', 'grace.oyelaran'], ['Sade Bello', 'sade.bello'], ['Emeka Nwosu', 'emeka.nwosu']];

export function composer(app, nav) {
  let draft = null;
  app.innerHTML = `
  <div class="wrap">
    <div class="pool-head"><div><p class="eyebrow">New pool</p><h2 style="margin-top:10px">What does the group want?</h2></div></div>
    <div class="composer">
      <div class="card stack">
        <label class="eyebrow" for="req">Tell the agent, the way you'd text the group</label>
        <textarea id="req" placeholder="e.g. Six of us want a big bag of jasmine rice, 8 lb each, nobody pays more than $14, close Friday"></textarea>
        <div class="examples">${EXAMPLES.map((e, i) => `<button data-ex="${i}">${esc(e.split(',')[0])}</button>`).join('')}</div>
        <div class="row-between"><button class="btn primary" id="go">Draft the pool <span class="arrow">→</span></button><span class="muted" style="font-size:14px">No money moves until you open the pool.</span></div>
        <ul class="thinking" id="thinking" hidden>
          <li data-s="0">Reading the request</li><li data-s="1">Sourcing offers across retailers</li><li data-s="2">Pricing it per household</li><li data-s="3">Checking it against the mandate</li>
        </ul>
      </div>
      <div id="draft" class="card flat empty">The draft pool shows up here: the deal, each member's share, and the rules the agent will follow.</div>
    </div>
  </div>`;

  const req = $('#req');
  app.querySelectorAll('[data-ex]').forEach((b) => (b.onclick = () => { req.value = EXAMPLES[+b.dataset.ex]; req.focus(); }));
  $('#go').onclick = async () => {
    const text = req.value.trim();
    if (text.length < 8) { req.focus(); return toast('Tell the agent what the group wants first.'); }
    const steps = [...app.querySelectorAll('#thinking li')];
    $('#thinking').hidden = false; steps.forEach((s) => (s.className = ''));
    let k = 0; steps[0].className = 'on';
    const timer = setInterval(() => { if (k < steps.length - 1) { steps[k].className = 'done'; steps[++k].className = 'on'; } }, 900);
    $('#go').disabled = true;
    try {
      draft = await api('/pools/draft', { method: 'POST', body: { text } });
      draft.request = text;
      clearInterval(timer); steps.forEach((s) => (s.className = 'done'));
      renderDraft();
    } catch (e) { clearInterval(timer); toast(e.message); steps.forEach((s) => (s.className = '')); }
    $('#go').disabled = false;
  };

  function renderDraft() {
    const d = draft, s = d.spec;
    const box = $('#draft'); box.className = 'card stack';
    const chosen = d.offers.find((o) => o.id === d.chosenOfferId);
    box.innerHTML = `
      <div class="row-between"><p class="eyebrow">Draft · ${esc(d.thinking.sourcing === 'channel3' ? 'live offers via Channel3' : 'offers from the curated catalog')}</p><span class="tag">${esc(d.thinking.parse)}</span></div>
      <h3>${esc(s.title)}</h3>
      <div class="fields">
        <label>Households<input id="f-h" type="number" min="2" max="50" value="${s.households}"></label>
        <label>Each gets (${esc(s.unit)})<input id="f-q" type="number" min="0.1" step="0.1" value="${s.qtyPerHousehold}"></label>
        <label>Cap per member ($)<input id="f-c" type="number" min="1" step="0.5" value="${(s.capPerMemberCents / 100).toFixed(2)}"></label>
        <label>Min paid members<input id="f-m" type="number" min="2" value="${d.mandate.minMembers}"></label>
        <label>Closes in (days)<input id="f-d" type="number" min="0.02" step="0.5" value="${Math.max(0.5, Math.round((Date.parse(s.deadline) - Date.now()) / 864e5 * 2) / 2)}"></label>
        <label>Organiser<input id="f-o" value="Kachi"></label>
      </div>
      <div class="bubble"><small>Agent</small>${esc(d.rationale)}</div>
      <div class="offers">${d.offers.slice(0, 5).map((o) => `
        <label class="${o.id === d.chosenOfferId ? 'sel' : ''} ${o.viable ? '' : 'nv'}">
          <input type="radio" name="offer" value="${esc(o.id)}" ${o.id === d.chosenOfferId ? 'checked' : ''} ${o.viable ? '' : 'disabled'}>
          <span class="offer" style="flex:1;min-width:0"><span class="thumb" ${o.image ? `style="background-image:url('${esc(o.image)}')"` : ''}>${o.image ? '' : esc(o.merchant[0])}</span>
          <span class="meta"><b>${esc(o.title)}</b><small>${esc(o.merchant)} · ${o.quote.packs} pack${o.quote.packs > 1 ? 's' : ''} · ${money(o.quote.totalCents)} total${o.viable ? '' : ' · over the cap'}</small></span></span>
          <span style="text-align:right"><b class="mono">${money(o.quote.perHouseholdCents)}</b><br><span class="save">−${o.quote.savingsPct}%</span></span>
        </label>`).join('') || '<p class="muted">No sized offers found. Name the product and how much each household gets.</p>'}</div>
      <div>
        <div class="row-between"><p class="eyebrow">Members</p><button class="btn ghost small" id="fill-n">Add demo neighbours</button></div>
        <textarea id="members" style="min-height:110px;font-size:15px;margin-top:10px" placeholder="One per line: Name, email"></textarea>
      </div>
      <div class="card flat" style="background:var(--cream);border:0"><p class="eyebrow" style="margin-bottom:8px">Mandate</p>${d.mandateText.map((t) => `<div style="font-size:14px;padding:3px 0">· ${esc(t)}</div>`).join('')}</div>
      <div class="row-between"><span class="muted" style="font-size:14px">${chosen ? `Each member pays <b class="mono" style="color:var(--ink)">${money(d.shareCents)}</b> up front. What isn't spent comes back.` : ''}</span><button class="btn red" id="open" ${chosen ? '' : 'disabled'}>Open the pool <span class="arrow">→</span></button></div>`;

    box.querySelectorAll('input[name=offer]').forEach((r) => (r.onchange = () => { d.chosenOfferId = r.value; box.querySelectorAll('.offers label').forEach((l) => l.classList.toggle('sel', l.querySelector('input').checked)); }));
    $('#fill-n').onclick = () => { $('#members').value = NEIGHBOURS.slice(0, +$('#f-h').value || s.households).map(([n, h]) => `${n}, ${h}@otu-demo.example`).join('\n'); };
    $('#open').onclick = async () => {
      const members = $('#members').value.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((x) => x[0]).map(([name, email]) => ({ name, email }));
      if (!members.length) return toast('Add the members first (or tap “Add demo neighbours”).');
      const spec = { ...s, households: +$('#f-h').value, qtyPerHousehold: +$('#f-q').value, capPerMemberCents: Math.round(+$('#f-c').value * 100), minMembers: +$('#f-m').value, deadline: new Date(Date.now() + +$('#f-d').value * 864e5).toISOString() };
      const mandate = { ...d.mandate, capPerMemberCents: spec.capPerMemberCents, minMembers: spec.minMembers, deadline: spec.deadline };
      $('#open').disabled = true;
      try {
        const pool = await api('/pools', { method: 'POST', body: { draft: { ...d, spec, mandate }, members, organiser: $('#f-o').value } });
        nav('/p/' + pool.id);
      } catch (e) { toast(e.message); $('#open').disabled = false; }
    };
  }
}
