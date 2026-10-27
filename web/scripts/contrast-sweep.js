/**
 * WCAG contrast sweep — paste into the devtools console on any page (or run it
 * through browser automation), once per theme.
 *
 * Walks every visible text node, composites the real ancestor background stack
 * (including the first stop of a gradient and every ancestor's opacity), and
 * reports each node under 4.5:1 (3:1 for large text: >= 24px, or >= 18.66px
 * bold). This is the sweep that found #57; it lives here so the next audit is
 * a paste rather than a rewrite.
 *
 * Known exemptions it does not know about, so read the output with them in
 * mind: disabled controls (WCAG 1.4.3 exempts them; ours fade to 0.45), and
 * the replayer table, which is a picture of a physical object and is themed
 * identically in both modes. The 13x13 matrix and SVG charts are skipped.
 *
 * Not in CI yet: that needs a headless browser in the pipeline. When it gets
 * one, this is the body of the test.
 */
(() => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      let c = parse(cs.backgroundColor);
      if ((!c || c.a === 0) && cs.backgroundImage.includes('gradient')) { const g = cs.backgroundImage.match(/rgba?\([^)]+\)/); if (g) c = parse(g[0]); }
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    let acc = parse(getComputedStyle(document.body).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
    return acc;
  };
  const fails = []; let n = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode; if (!t.textContent.trim()) continue;
    const el = t.parentElement; const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[aria-hidden=true], .stats-matrix, svg')) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const fg = parse(cs.color); if (!fg || fg.a === 0) continue;
    let op = 1;
    for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    const bg = bgOf(el); const f = over({ ...fg, a: fg.a * op }, bg);
    const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5; n++;
    if (ratio < need - 0.01) fails.push(`${ratio.toFixed(2)} ${cs.color} ${el.className || el.tagName} :: ${t.textContent.trim().slice(0, 40)}`);
  }
  return { nodes: n, fails: fails.length, sample: [...new Set(fails)].slice(0, 25) };
})()
