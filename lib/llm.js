// The model layer. The agent *thinks* here: reading a messy request, weighing
// offers, writing reminders people actually answer. It never moves money —
// everything it proposes goes through the mandate engine first.
//
// Providers: Gemini (GEMINI_API_KEY) first, Groq (GROQ_API_KEY) second, and a
// deterministic fallback so the product still works with no keys at all.

async function gemini(env, system, user) {
  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  return { json: JSON.parse(text), provider: `gemini:${model}` };
}

async function groq(env, system, user) {
  const model = env.GROQ_MODEL || 'qwen/qwen3.8-27b';
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.3, response_format: { type: 'json_object' }, max_completion_tokens: 1500, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`groq ${r.status}`);
  const j = await r.json();
  return { json: JSON.parse(j.choices[0].message.content), provider: `groq:${model}` };
}

export async function think(env, system, user, fallback) {
  const errors = [];
  for (const [name, fn] of [['gemini', gemini], ['groq', groq]]) {
    const key = name === 'gemini' ? env.GEMINI_API_KEY : env.GROQ_API_KEY;
    if (!key) continue;
    try { return { ...(await fn(env, system, user)), errors }; } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  return { json: fallback(), provider: 'rules', errors };
}

// ---- 1. request -> pool spec ----------------------------------------------

const SPEC_SYSTEM = `You turn a group-buy organiser's message into a pool spec for a purchasing agent.
Return JSON only: {"title": short human title, "item": what to buy, "query": product search query (2-6 words, no quantities),
"unit": one of lb|kg|oz|gal|l|ct, "qtyPerHousehold": number of units each household gets, "households": integer,
"capPerMember": max USD any one member pays (number), "minMembers": integer (default: ceil(households*0.6), at least 2),
"deadlineDays": days from now until the pool closes (number, default 3), "notes": anything else the agent must respect (string)}.
Never invent a cap higher than the organiser said. If no cap was given, set it to null.`;

const WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };

export function ruleSpec(text) {
  const t = String(text).toLowerCase().replace(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\b/g, (w) => String(WORDS[w]));
  const num = (re, d) => { const m = t.match(re); return m ? parseFloat(m[1]) : d; };
  const households = num(/(\d+)\s*(?:households|families|homes|people|members|of us|friends|neighbou?rs|parents|flats)/, 5);
  const unitMatch = t.match(/(\d+(?:\.\d+)?)\s*-?\s*(lb|lbs|pounds?|kg|kilos?|oz|gal|gallons?|l|liters?|litres?|count|ct|pack)\b/);
  const unitWord = unitMatch ? unitMatch[2] : 'ct';
  const unit = /lb|pound/.test(unitWord) ? 'lb' : /kg|kilo/.test(unitWord) ? 'kg' : /gal/.test(unitWord) ? 'gal' : /^l|liter|litre/.test(unitWord) ? 'l' : /oz/.test(unitWord) ? 'oz' : 'ct';
  const qty = unitMatch ? parseFloat(unitMatch[1]) : 1;
  const cap = num(/(?:\$|usd\s*)(\d+(?:\.\d+)?)/, null) ?? num(/(\d+(?:\.\d+)?)\s*(?:dollars|usd)/, null);
  const days = /friday/.test(t) ? 3 : /tomorrow/.test(t) ? 1 : /week/.test(t) ? 7 : num(/(\d+)\s*days?/, 3);
  const items = ['rice', 'beans', 'oil', 'diapers', 'detergent', 'toilet paper', 'flour', 'sugar', 'garri', 'yam'];
  const base = items.find((i) => t.includes(i));
  const adj = base ? (t.match(new RegExp(`([a-z]+)\\s+${base}`)) || [])[1] : null;
  const skip = new Set(['of', 'a', 'the', 'big', 'some', 'want', 'bag', 'splitting', 'buy', 'dry', 'and', 'want', 'for', 'more']);
  const item = base ? (adj && !skip.has(adj) && !/^\d/.test(adj) ? `${adj} ${base}` : base) : t.split(/[,.]/)[0].slice(0, 40);
  return { title: `${item[0].toUpperCase()}${item.slice(1)} for ${households} households`, item, query: item, unit, qtyPerHousehold: qty, households, capPerMember: cap, minMembers: Math.max(2, Math.ceil(households * 0.6)), deadlineDays: days, notes: '' };
}

export async function parseRequest(env, text) {
  const out = await think(env, SPEC_SYSTEM, text, () => ruleSpec(text));
  const s = { ...ruleSpec(text), ...Object.fromEntries(Object.entries(out.json || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')) };
  s.households = Math.max(2, Math.min(50, Math.round(s.households)));
  s.minMembers = Math.max(2, Math.min(s.households, Math.round(s.minMembers)));
  s.qtyPerHousehold = Math.max(0.1, Number(s.qtyPerHousehold) || 1);
  return { spec: s, provider: out.provider, errors: out.errors };
}

// ---- 2. why this offer -------------------------------------------------------

export async function explainChoice(env, { spec, ranked }) {
  const top = ranked.slice(0, 4).map((o) => ({ title: o.title, merchant: o.merchant, perHousehold: (o.quote.perHouseholdCents / 100).toFixed(2), alone: (o.quote.aloneCents / 100).toFixed(2), savingsPct: o.quote.savingsPct, packs: o.quote.packs, leftover: o.quote.leftoverUnits, viable: o.viable }));
  const fb = () => {
    const b = ranked.find((o) => o.viable) || ranked[0];
    if (!b) return { rationale: 'No offer fits the cap yet.' };
    return { rationale: `${b.merchant}'s ${b.title} works out to $${(b.quote.perHouseholdCents / 100).toFixed(2)} a household vs $${(b.quote.aloneCents / 100).toFixed(2)} buying alone (${b.quote.savingsPct}% less), in ${b.quote.packs} pack${b.quote.packs > 1 ? 's' : ''}.` };
  };
  const out = await think(env, 'You are a frugal, plain-spoken group-buy agent. Given candidate offers (already priced per household), explain in ONE or TWO short sentences which offer you pick and why, with the numbers. Pick the cheapest viable one unless leftover waste or a bad merchant changes it. JSON: {"rationale": string}', JSON.stringify({ want: spec, offers: top }), fb);
  return { rationale: out.json.rationale || fb().rationale, provider: out.provider };
}

// ---- 3. reminders that sound like a person ----------------------------------

export async function writeReminder(env, { pool, member, hoursLeft, nth }) {
  const paid = pool.members.filter((m) => m.status === 'paid').length;
  const fb = () => ({
    subject: `${pool.title}: your share is ${'$' + (member.shareCents / 100).toFixed(2)}`,
    note: `Hi ${member.name.split(' ')[0]}, ${paid} of ${pool.spec.households} households are in for ${pool.title.toLowerCase()}. Your share is $${(member.shareCents / 100).toFixed(2)} and the pool closes in about ${Math.max(1, Math.round(hoursLeft))} hours. Anything we don't spend comes straight back to you.`,
  });
  const out = await think(env, `You write short, warm payment reminders for a neighbourhood group buy, as the organiser's assistant. Never guilt-trip, never threaten, max 2 sentences, include the amount, how many are already in, and the time left. Reminder number ${nth}: later reminders can be a little more direct. JSON: {"subject": string (max 70 chars), "note": string}`, JSON.stringify({ member: member.name, amount: (member.shareCents / 100).toFixed(2), alreadyIn: paid, households: pool.spec.households, hoursLeft: Math.round(hoursLeft), item: pool.title, organiser: pool.organiser?.name }), fb);
  return { ...fb(), ...out.json, provider: out.provider };
}
