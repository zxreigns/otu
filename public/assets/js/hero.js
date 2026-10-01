// Brand motion: scattered dots (households) drift in and settle into one ring.
// "Otu" is Igbo for "one". Canvas, no libraries, respects reduced motion.
export function heroCanvas(canvas, { count = 140, ringFrac = 0.22, color = '#121212', accent = '#E8412F' } = {}) {
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W, H, dpr, pts = [], t0 = performance.now(), raf;
  function size() {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function seed() {
    pts = Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2;
      return { a, sx: Math.random() * W, sy: Math.random() * H, r: 1.2 + Math.random() * 1.8, d: Math.random() * 1.2, hot: i % 23 === 0 };
    });
  }
  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  function frame(now) {
    const t = (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    const cx = W > 900 ? W * 0.74 : W * 0.5, cy = W > 900 ? H * 0.46 : H * 0.62;
    const R = Math.min(W, H) * ringFrac * (W > 900 ? 1.25 : 1);
    // halftone grid
    ctx.fillStyle = 'rgba(18,18,18,.07)';
    for (let x = 12; x < W; x += 22) for (let y = 12; y < H; y += 22) {
      const dist = Math.hypot(x - cx, y - cy) / (R * 2.6);
      const s = Math.max(0, 1.4 - dist) * 1.1;
      if (s > 0.05) { ctx.beginPath(); ctx.arc(x, y, s, 0, 6.283); ctx.fill(); }
    }
    // orbit lines
    ctx.strokeStyle = 'rgba(18,18,18,.10)'; ctx.lineWidth = 1;
    for (const k of [1.55, 2.1]) { ctx.beginPath(); ctx.arc(cx, cy, R * k, 0, 6.283); ctx.stroke(); }
    const spin = t * 0.08;
    for (const p of pts) {
      const k = reduce ? 1 : ease((t - p.d) / 2.6);
      const a = p.a + spin;
      const breathe = 1 + Math.sin(t * 1.4 + p.a * 3) * 0.015;
      const tx = cx + Math.cos(a) * R * breathe, ty = cy + Math.sin(a) * R * breathe;
      const x = p.sx + (tx - p.sx) * k, y = p.sy + (ty - p.sy) * k;
      ctx.fillStyle = p.hot ? accent : color;
      ctx.globalAlpha = 0.25 + 0.75 * k;
      ctx.beginPath(); ctx.arc(x, y, p.hot ? p.r + 1.4 : p.r, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // satellite: one red dot orbiting = the agent
    const sa = t * 0.6;
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(cx + Math.cos(sa) * R * 1.55, cy + Math.sin(sa) * R * 1.55, 5, 0, 6.283); ctx.fill();
    if (!reduce) raf = requestAnimationFrame(frame);
  }
  size(); seed(); raf = requestAnimationFrame(frame);
  const onR = () => { size(); seed(); t0 = performance.now() - 3000; };
  addEventListener('resize', onR);
  return () => { cancelAnimationFrame(raf); removeEventListener('resize', onR); };
}
