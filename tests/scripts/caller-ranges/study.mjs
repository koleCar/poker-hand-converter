// Caller-range study (analysis/19): the candidate ranges, their fits and the
// held-out evaluation. WEIGHT=1 weights each shown hand by how often its
// player plays the line against how often they show it down; the showdown
// bias is measured on the same players' open-raises against the charts.
import { rows, NAMES, ll, llMix, chartRangeOf, ATC, combos } from "./lib.mjs";

const RANK = "23456789TJQKA";
const sig = (x) => 1 / (1 + Math.exp(-x));
const FEAT = NAMES.map((n) => {
  const hi = RANK.indexOf(n[0]);
  const lo = RANK.indexOf(n[1]);
  const pair = n.length === 2 ? 1 : 0;
  const suited = n.endsWith("s") ? 1 : 0;
  const gap = pair ? 0 : hi - lo - 1;
  return [1, pair, suited, hi / 12, lo / 12, pair ? 0 : Math.min(gap, 4) / 4, hi === 12 && !pair ? 1 : 0, lo >= 8 ? 1 : 0, pair * (lo / 12)];
});
const NF = FEAT[0].length;

/* ---------- Nelder-Mead ---------- */
function nm(f, x0, step = 0.5, iters = 400) {
  const n = x0.length;
  let pts = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += step;
    pts.push(p);
  }
  let vals = pts.map(f);
  for (let it = 0; it < iters * n; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = order.map((i) => pts[i]);
    vals = order.map((i) => vals[i]);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
    const xr = c.map((v, j) => v + (v - pts[n][j]));
    const fr = f(xr);
    if (fr < vals[0]) {
      const xe = c.map((v, j) => v + 2 * (v - pts[n][j]));
      const fe = f(xe);
      if (fe < fr) [pts[n], vals[n]] = [xe, fe];
      else [pts[n], vals[n]] = [xr, fr];
    } else if (fr < vals[n - 1]) [pts[n], vals[n]] = [xr, fr];
    else {
      const xc = c.map((v, j) => v + 0.5 * (pts[n][j] - v));
      const fc = f(xc);
      if (fc < vals[n]) [pts[n], vals[n]] = [xc, fc];
      else {
        for (let i = 1; i <= n; i++) {
          pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j]));
          vals[i] = f(pts[i]);
        }
      }
    }
    if (Math.abs(vals[n] - vals[0]) < 1e-7) break;
  }
  const best = vals.indexOf(Math.min(...vals));
  return pts[best];
}

/* ---------- per-row chart quantities ---------- */
function deltas(r) {
  const n = r.node;
  if (!n) return null;
  const fold = n.actions.indexOf("fold");
  const call = n.actions.indexOf("call");
  const raise = n.actions.findIndex((a) => a === "raise" || a === "allin");
  if (call < 0) return null;
  const base = (k) => (fold >= 0 ? n.ev[fold * 169 + k] : -n.inBb);
  const pot = Math.max(1, n.potBb);
  const dc = [];
  const db = [];
  const fc = [];
  const fr = [];
  for (let k = 0; k < 169; k++) {
    const c = (n.ev[call * 169 + k] - base(k)) / pot;
    const rr = raise >= 0 ? (n.ev[raise * 169 + k] - base(k)) / pot : -Infinity;
    dc.push(c);
    db.push(Math.max(c, rr));
    fc.push(n.freq[call * 169 + k]);
    fr.push(raise >= 0 ? n.freq[raise * 169 + k] : 0);
  }
  return { dc, db, fc, fr, reach: n.range };
}
for (const r of rows) r.d = deltas(r);
if (process.env.WEIGHT === "1") {
  const { readFileSync } = await import("node:fs");
  const t = JSON.parse(readFileSync(`${process.env.CALLERS_OUT}.tally.json`, "utf8"));
  const N = {}, S = {}, Ns = {}, Ss = {};
  for (const [k, v] of Object.entries(t)) { const [vil, src] = k.split(" "); N[`${vil} ${src}`] = v; Ns[src] = (Ns[src] ?? 0) + v; }
  for (const r of rows) if (!r.allIn) { const key = `${r.villain} ${r.source}`; S[key] = (S[key] ?? 0) + 1; Ss[r.source] = (Ss[r.source] ?? 0) + 1; }
  for (const r of rows) {
    const key = `${r.villain} ${r.source}`;
    if (r.allIn || !N[key]) continue;
    r.wt = Math.min(4, (N[key] / S[key]) * (Ss[r.source] / Ns[r.source]));
  }
}

/* ---------- showdown bias, from opens (own-depth charts) ---------- */
function biasFrom(train) {
  const opens = train.filter((r) => r.source === "open" && !r.allIn && r.node?.how === "own");
  const base = opens.map((r) => chartRangeOf(r.node));
  const loss = (eta) => {
    const s = FEAT.map((x) => Math.exp(x.reduce((a, v, j) => a + v * (j === 0 ? 0 : eta[j]), 0)));
    let tot = 0;
    for (let i = 0; i < opens.length; i++) tot += llMix(base[i].map((w, k) => w * s[k]), opens[i].shown, 0.05);
    return -tot / opens.length + 0.01 * eta.reduce((a, v) => a + v * v, 0);
  };
  const eta = nm(loss, new Array(NF).fill(0), 0.3, 200);
  return FEAT.map((x) => Math.exp(x.reduce((a, v, j) => a + v * (j === 0 ? 0 : eta[j]), 0)));
}

/* ---------- candidates ---------- */
// Each: fit(train) -> params; range(r, params) -> 169 array or null (null = fallback to placeholder).
const qre = (key, withFloor) => ({
  params: withFloor ? 3 : 2,
  range: (r, p) => {
    if (!r.d) return null;
    const floor = withFloor ? sig(p[2]) : 0;
    return r.d[key].map((v, k) => r.d.reach[k] * (floor + (1 - floor) * sig((v - p[0]) / Math.exp(p[1]))));
  },
  x0: withFloor ? [0, -2, -4] : [0, -2],
});
const shape = (withDelta) => ({
  params: NF + (withDelta ? 1 : 0),
  range: (r, p) => {
    if (withDelta && !r.d) return null;
    return FEAT.map((x, k) => sig(x.reduce((a, v, j) => a + v * p[j], 0) + (withDelta ? p[NF] * r.d.db[k] * 10 : 0)));
  },
  x0: new Array(NF + (withDelta ? 1 : 0)).fill(0),
});
const LATE = new Set(["CO", "BTN"]);
const ctx = (r) => [LATE.has(r.position) ? 1 : 0, r.toCall / Math.max(1, r.pot + r.toCall), r.callers + r.limpers > 0 ? 1 : 0, r.position === "SB" ? 1 : 0];
const shapeCtx = {
  params: NF + 4,
  range: (r, p) => {
    const c = ctx(r);
    const shift = c.reduce((a, v, j) => a + v * p[NF + j], 0);
    return FEAT.map((x) => sig(x.reduce((a, v, j) => a + v * p[j], 0) + shift));
  },
  x0: new Array(NF + 4).fill(0),
};
const SRC = ["cold-call", "bb-defence", "first-limp", "over-limp", "limp-call"];
const shapeSrc = {
  params: NF + SRC.length,
  range: (r, p) => {
    const shift = p[NF + SRC.indexOf(r.source)] ?? 0;
    return FEAT.map((x) => sig(x.reduce((a, v, j) => a + v * p[j], 0) + shift));
  },
  x0: new Array(NF + SRC.length).fill(0),
};
export const CANDIDATES = {
  placeholder: { params: 0, range: (r) => r.placeholder },
  chart: { params: 0, range: (r) => chartRangeOf(r.node) },
  current: { params: 0, range: (r) => r.current?.range ?? null },
  atc: { params: 0, range: () => ATC },
  "call+3bet": { params: 0, range: (r) => (r.d ? r.d.fc.map((f, k) => r.d.reach[k] * (f + r.d.fr[k])) : null) },
  "qre-call": qre("dc", false),
  "qre-best": qre("db", false),
  "qre-best+floor": qre("db", true),
  shape: shape(false),
  "shape+delta": shape(true),
  "shape+ctx": shapeCtx,
  "shape-pooled": shapeSrc,
};
if (process.env.ONLY) for (const k of Object.keys(CANDIDATES)) if (!process.env.ONLY.split(",").includes(k)) delete CANDIDATES[k];

function fit(cand, train, bias) {
  if (!cand.params) return [];
  const loss = (p) => {
    let tot = 0;
    let n = 0;
    for (const r of train) {
      const w = cand.range(r, p);
      if (!w) continue;
      const ws = bias ? w.map((v, k) => v * bias[k]) : w;
      tot += (r.wt ?? 1) * llMix(ws, r.shown, 0.05);
      n += r.wt ?? 1;
    }
    return -tot / Math.max(1, n) + 0.001 * p.reduce((a, v) => a + v * v, 0);
  };
  return nm(loss, cand.x0, 0.5, 300);
}

export function evaluate(rowsOf, folds, { bias = false } = {}) {
  // returns per candidate arrays of per-row scores (held-out)
  const out = {};
  for (const name of Object.keys(CANDIDATES)) out[name] = { ll: [], mix: [], hold: [], llAdj: [], combos: [], params: [] };
  const all = rowsOf;
  const foldIds = [...new Set(all.map(folds))];
  for (const f of foldIds) {
    const test = all.filter((r) => folds(r) === f);
    const train = all.filter((r) => folds(r) !== f);
    // bias estimated on the train opens of the whole data set (not just this source)
    const biasTrain = biasFrom(rows.filter((r) => folds(r) !== f));
    for (const [name, cand] of Object.entries(CANDIDATES)) {
      const p = fit(cand, train, bias ? biasTrain : null);
      out[name].params.push(p);
      for (const r of test) {
        const w = cand.range(r, p) ?? r.placeholder;
        out[name].ll.push(ll(w, r.shown));
        out[name].mix.push(llMix(w, r.shown));
        out[name].llAdj.push(llMix(w.map((v, k) => v * biasTrain[k]), r.shown));
        const mx = Math.max(...w);
        out[name].hold.push(w[r.shown] > 0.05 * mx ? 1 : 0);
        out[name].combos.push(combos(w) / mx);
        out[name].src ??= [];
        out[name].src.push(r.source);
        out[name].wt ??= [];
        out[name].wt.push(r.wt ?? 1);
        out[name].villain ??= [];
        out[name].villain.push(r.villain);
      }
    }
  }
  return out;
}
export { biasFrom, fit, FEAT };
