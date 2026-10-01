// Money helpers. All amounts are handled as integer cents internally so the
// mandate engine never rounds its way past a cap.

export const toCents = (v) => Math.round(Number(v || 0) * 100);
export const fromCents = (c) => Math.round(c) / 100;
export const fmt = (c, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(fromCents(c));
export const value = (c) => (Math.round(c) / 100).toFixed(2); // PayPal "value" string

// Split `total` cents across `n` people so the parts sum exactly to total.
// The first (total % n) people carry one extra cent.
export function splitEven(total, n) {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

// Split `total` cents proportionally to `weights` (largest-remainder method),
// exact to the cent.
export function splitWeighted(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < order.length && rest > 0; k++, rest--) floors[order[k][1]] += 1;
  return floors;
}
