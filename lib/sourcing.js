// Offer sourcing. Live: Channel3's product graph (POST /v1/search).
// Without a CHANNEL3_API_KEY the same interface answers from a curated catalog
// fixture (representative retail list prices for real retailers; demo data,
// not live), and every offer says which source it came from.

import { toCents } from './money.js';

const UNIT_ALIASES = {
  lb: ['lb', 'lbs', 'pound', 'pounds'],
  kg: ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms'],
  oz: ['oz', 'ounce', 'ounces'],
  l: ['l', 'liter', 'liters', 'litre', 'litres'],
  gal: ['gal', 'gallon', 'gallons'],
  ct: ['ct', 'count', 'pack', 'pk', 'pcs', 'pieces', 'diapers', 'rolls', 'bars', 'cans', 'bottles'],
};
const CONVERT = { kg: { lb: 2.20462 }, lb: { kg: 0.453592 }, l: { gal: 0.264172 }, gal: { l: 3.78541 }, oz: { lb: 1 / 16 }, };

export function normaliseUnit(u = '') {
  const s = String(u).toLowerCase().trim();
  for (const [k, v] of Object.entries(UNIT_ALIASES)) if (k === s || v.includes(s)) return k;
  return s || 'ct';
}

// "Mahatma Jasmine Rice, 25 lb Bag" -> 25 (in lb). Handles "2 x 10 lb", "Pack of 12", "50-lb".
export function packSizeFromTitle(title, unit) {
  const u = normaliseUnit(unit);
  const t = ' ' + String(title).toLowerCase().replace(/[,()]/g, ' ') + ' ';
  const units = Object.entries(UNIT_ALIASES).flatMap(([k, v]) => [k, ...v].map((a) => [k, a]));
  let best = null;
  const multi = t.match(/(\d+)\s*(?:x|×)\s*(\d+(?:\.\d+)?)\s*-?\s*([a-z]+)/);
  for (const [k, alias] of units) {
    const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*-?\\s*${alias}\\b`);
    const m = t.match(re);
    if (m) {
      let n = parseFloat(m[1]);
      if (multi && normaliseUnit(multi[3]) === k) n = parseInt(multi[1], 10) * parseFloat(multi[2]);
      if (k === u) return n;
      if (CONVERT[k]?.[u]) best = best ?? n * CONVERT[k][u];
    }
  }
  if (u === 'ct') {
    const m = t.match(/pack of (\d+)/) || t.match(/(\d+)\s*-?\s*(?:pack|pk|count|ct)\b/);
    if (m) return parseInt(m[1], 10);
  }
  return best;
}

// --- curated fixture --------------------------------------------------------
// Representative US retail list prices (USD). Demo data: the live path is Channel3.
const CATALOG = [
  { sku: 'rice-jasmine-50', title: 'Royal Thai Jasmine Rice, 50 lb Bag', merchant: 'Costco', merchantDomain: 'costco.com', price: 42.99, size: 50, unit: 'lb', kind: 'rice', rating: 4.8, shipping: 0 },
  { sku: 'rice-jasmine-25', title: 'Mahatma Jasmine Rice, 25 lb Bag', merchant: 'Walmart', merchantDomain: 'walmart.com', price: 24.48, size: 25, unit: 'lb', kind: 'rice', rating: 4.7, shipping: 0 },
  { sku: 'rice-lg-50', title: "Member's Mark Long Grain White Rice, 50 lb", merchant: "Sam's Club", merchantDomain: 'samsclub.com', price: 29.98, size: 50, unit: 'lb', kind: 'rice', rating: 4.6, shipping: 6.0 },
    { sku: 'rice-jasmine-10', title: 'Mahatma Jasmine Rice, 10 lb Bag', merchant: 'Target', merchantDomain: 'target.com', price: 13.99, size: 10, unit: 'lb', kind: 'rice', rating: 4.7, shipping: 0 },
  { sku: 'oil-veg-35', title: 'Vegetable Oil, 35 lb Jug (approx. 4.5 gal)', merchant: 'Costco', merchantDomain: 'costco.com', price: 39.99, size: 4.5, unit: 'gal', kind: 'oil', rating: 4.7, shipping: 0 },
  { sku: 'oil-veg-1', title: 'Crisco Pure Vegetable Oil, 1 gal', merchant: 'Walmart', merchantDomain: 'walmart.com', price: 10.97, size: 1, unit: 'gal', kind: 'oil', rating: 4.8, shipping: 0 },
  { sku: 'beans-black-25', title: 'Black Beans, Dry, 25 lb Bag', merchant: 'WebstaurantStore', merchantDomain: 'webstaurantstore.com', price: 36.49, size: 25, unit: 'lb', kind: 'beans', rating: 4.6, shipping: 8.0 },
  { sku: 'beans-black-2', title: 'Goya Black Beans, Dry, 2 lb', merchant: 'Target', merchantDomain: 'target.com', price: 4.29, size: 2, unit: 'lb', kind: 'beans', rating: 4.8, shipping: 0 },
  { sku: 'diapers-s3-198', title: 'Kirkland Signature Diapers Size 3, 198 count', merchant: 'Costco', merchantDomain: 'costco.com', price: 47.99, size: 198, unit: 'ct', kind: 'diapers', rating: 4.8, shipping: 0 },
  { sku: 'diapers-s3-34', title: 'Pampers Cruisers Diapers Size 3, 34 count', merchant: 'Walgreens', merchantDomain: 'walgreens.com', price: 15.49, size: 34, unit: 'ct', kind: 'diapers', rating: 4.7, shipping: 0 },
  { sku: 'det-pods-152', title: 'Tide PODS Laundry Detergent, 152 count', merchant: 'Costco', merchantDomain: 'costco.com', price: 37.99, size: 152, unit: 'ct', kind: 'detergent', rating: 4.8, shipping: 0 },
  { sku: 'det-pods-42', title: 'Tide PODS Laundry Detergent, 42 count', merchant: 'Target', merchantDomain: 'target.com', price: 13.99, size: 42, unit: 'ct', kind: 'detergent', rating: 4.8, shipping: 0 },
  { sku: 'tp-30', title: 'Charmin Ultra Soft Toilet Paper, 30 Mega Rolls', merchant: 'Costco', merchantDomain: 'costco.com', price: 32.99, size: 30, unit: 'ct', kind: 'toilet paper', rating: 4.8, shipping: 0 },
  { sku: 'tp-6', title: 'Charmin Ultra Soft Toilet Paper, 6 Mega Rolls', merchant: 'Walgreens', merchantDomain: 'walgreens.com', price: 9.49, size: 6, unit: 'ct', kind: 'toilet paper', rating: 4.7, shipping: 0 },
];

function catalogSearch(query, unit) {
  const q = String(query).toLowerCase();
  const words = q.split(/\W+/).filter((w) => w.length > 2);
  const u = normaliseUnit(unit);
  const scored = CATALOG.map((p) => ({ p, score: words.filter((w) => p.title.toLowerCase().includes(w)).length + (q.includes(p.kind) ? 1 : 0) })).filter((x) => x.score > 0);
  const top = Math.max(0, ...scored.map((x) => x.score));
  // prefer the closest matches ("jasmine rice" keeps the jasmine bags), but keep at least three to compare
  const keep = scored.filter((x) => x.score === top).length >= 3 ? scored.filter((x) => x.score === top) : scored;
  return keep.map((x) => x.p)
    .map((p) => {
      let size = p.size;
      const pu = normaliseUnit(p.unit);
      if (pu !== u && CONVERT[pu]?.[u]) size = p.size * CONVERT[pu][u];
      else if (pu !== u) return null;
      return {
        id: 'cat_' + p.sku,
        title: p.title,
        merchant: p.merchant,
        merchantDomain: p.merchantDomain,
        url: `https://${p.merchantDomain}/`,
        image: null,
        kind: p.kind,
        packSize: Math.round(size * 100) / 100,
        packPriceCents: toCents(p.price),
        shippingCents: toCents(p.shipping),
        rating: p.rating,
        source: 'catalog',
        fetchedAt: new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

async function channel3Search(query, unit, key) {
  const r = await fetch('https://api.trychannel3.com/v1/search', {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ query, limit: 20, filters: { availability: ['InStock'] } }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`channel3 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const products = data.products || data.results || [];
  const offers = [];
  for (const p of products) {
    const size = packSizeFromTitle(p.title, unit);
    if (!size) continue;
    const img = (p.images || []).find((i) => i.is_main_image) || (p.images || [])[0];
    for (const o of p.offers || []) {
      const price = o.price?.price ?? o.price?.amount;
      if (!price || o.availability === 'OutOfStock' || (o.price?.currency && o.price.currency !== 'USD')) continue;
      offers.push({
        id: `c3_${p.id}_${o.domain}`,
        title: p.title,
        merchant: o.domain.replace(/^www\./, '').replace(/\.(com|net|org|co)$/, ''),
        merchantDomain: o.domain.replace(/^www\./, ''),
        url: o.url,
        image: img ? img.cleaned_url || img.url : null,
        packSize: size,
        packPriceCents: toCents(price),
        shippingCents: 0,
        rating: null,
        source: 'channel3',
        fetchedAt: new Date().toISOString(),
      });
    }
  }
  return offers;
}

// "Buying alone" baseline: the per-unit price of the smallest pack that still
// covers one household's quantity (what each family would buy on their own).
export function withAloneBaseline(offers, qtyPerHousehold) {
  if (!offers.length) return offers;
  const enough = offers.filter((o) => o.packSize >= qtyPerHousehold * 0.8).sort((a, b) => a.packSize - b.packSize);
  const ref = enough[0] || offers.slice().sort((a, b) => a.packSize - b.packSize)[0];
  const aloneUnit = (ref.packPriceCents + (ref.shippingCents || 0)) / ref.packSize;
  return offers.map((o) => ({ ...o, retailUnitCents: Math.max(aloneUnit, (o.packPriceCents + (o.shippingCents || 0)) / o.packSize), aloneRef: { title: ref.title, merchant: ref.merchant } }));
}

export async function sourceOffers({ query, unit, qtyPerHousehold }, env = process.env) {
  const notes = [];
  let offers = [];
  if (env.CHANNEL3_API_KEY) {
    try {
      offers = await channel3Search(query, unit, env.CHANNEL3_API_KEY);
      notes.push(`channel3: ${offers.length} sized offers for "${query}"`);
    } catch (e) {
      notes.push(`channel3 failed (${e.message}); using catalog`);
    }
  } else notes.push('no CHANNEL3_API_KEY; using curated catalog');
  if (offers.length < 2) offers = offers.concat(catalogSearch(query, unit));
  // keep the cheapest listing per (title, merchant)
  const seen = new Map();
  for (const o of offers) {
    const k = (o.title + '|' + o.merchantDomain).toLowerCase();
    if (!seen.has(k) || seen.get(k).packPriceCents > o.packPriceCents) seen.set(k, o);
  }
  return { offers: withAloneBaseline([...seen.values()], qtyPerHousehold), notes, source: offers.some((o) => o.source === 'channel3') ? 'channel3' : 'catalog' };
}

// Re-check a price right before buying. Live sources re-query; the catalog
// applies the real-world wobble the mandate's drift rule exists for.
export async function requote(offer, env = process.env, wobblePct = 0) {
  if (offer.source === 'channel3' && env.CHANNEL3_API_KEY) {
    try {
      const fresh = await channel3Search(offer.title, 'ct', env.CHANNEL3_API_KEY);
      const same = fresh.find((o) => o.merchantDomain === offer.merchantDomain);
      if (same) return { ...offer, packPriceCents: same.packPriceCents, fetchedAt: same.fetchedAt, requoted: 'live' };
    } catch {}
  }
  return { ...offer, packPriceCents: Math.round(offer.packPriceCents * (1 + wobblePct / 100)), fetchedAt: new Date().toISOString(), requoted: offer.source === 'catalog' ? 'catalog' : 'cached' };
}

export const _catalog = CATALOG;
