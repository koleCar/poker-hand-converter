// Per-villain study (analysis/20): does a villain's own statistics - from the
// learner's library, without the held-out hand - widen or narrow the
// population range (`population/1`) of their flat call or limp usefully?
//
//   CALLERS_OUT=/local/shown.jsonl WEIGHT=1 [STATS=loo|prior] node villain.mjs
//
// Reads the extract step's LOCAL files (`shown.jsonl` and `shown.jsonl.stats.jsonl`,
// every opponent's statistics counters per hand). Five folds by player, as
// population/1: in each, the population shape is fitted on the other players
// (through the showdown bias, weighted), the adjustment's parameters on the
// other players too, and every held-out shown hand is scored with its
// player's statistics counted over their OTHER hands (STATS=loo, the
// default) or only over the hands played before it (STATS=prior).
//
// The adjustment shifts the line's logit by
//     δ = γ · (logit(r̂) − logit(p)),   r̂ = (made + k·p) / (chances + k)
// where p is the pool's rate of the stat (the training players'), and
// nothing below MIN chances. Prints, per candidate and line, the mean
// log-likelihood per combo and its difference to population-only, with
// standard errors clustered by player.
import { readFileSync } from "node:fs";
import { rows, ll, llMix, combos } from "./lib.mjs";
import { CANDIDATES, biasFrom, fit } from "./study.mjs";

const SRC = ["cold-call", "bb-defence", "first-limp", "over-limp", "limp-call"];
const MODE = process.env.STATS ?? "loo";
const MIN = Number(process.env.MIN ?? 0);
const sig = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(p / (1 - p));
const clamp = (p) => Math.min(0.995, Math.max(0.005, p));

/* ---------- each opponent's counters, per hand ---------- */
const perHand = readFileSync(`${process.env.CALLERS_OUT}.stats.jsonl`, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const byVillain = new Map();
for (const s of perHand) {
  if (!byVillain.has(s.villain)) byVillain.set(s.villain, []);
  byVillain.get(s.villain).push(s);
}
const KEYS = ["hands", "vpip_opp", "vpip", "pfr", "limp_opp", "limp", "cold_call_opp", "cold_call", "fold_to_steal_opp", "call_steal"];
const sum = (list, skip) => {
  const t = Object.fromEntries(KEYS.map((k) => [k, 0]));
  for (const s of list) {
    if (skip(s)) continue;
    for (const k of KEYS) t[k] += s.c[k] ?? 0;
  }
  return t;
};
const rs = rows.filter((r) => SRC.includes(r.source) && !r.allIn);
for (const r of rs) {
  const list = byVillain.get(r.villain) ?? [];
  r.stats = MODE === "prior" ? sum(list, (s) => !(s.date < r.date)) : sum(list, (s) => s.h === r.h);
}

/* ---------- the statistics a line reads ---------- */
// [made, chances] of a villain's counters.
const STATS = {
  passive: (t) => [t.vpip - t.pfr, t.vpip_opp],
  vpip: (t) => [t.vpip, t.vpip_opp],
  coldCall: (t) => [t.cold_call, t.cold_call_opp],
  limp: (t) => [t.limp, t.limp_opp],
  callSteal: (t) => [t.call_steal, t.fold_to_steal_opp],
};
// Which stat each line reads, per candidate.
const LINE_STAT = {
  passive: { "cold-call": "passive", "bb-defence": "passive", "first-limp": "passive", "over-limp": "passive", "limp-call": "passive" },
  vpip: { "cold-call": "vpip", "bb-defence": "vpip", "first-limp": "vpip", "over-limp": "vpip", "limp-call": "vpip" },
  specific: { "cold-call": "coldCall", "bb-defence": "passive", "first-limp": "limp", "over-limp": "limp", "limp-call": "limp" },
  steal: { "cold-call": "coldCall", "bb-defence": "callSteal", "first-limp": "limp", "over-limp": "limp", "limp-call": "limp" },
};

function poolRates(villains) {
  // The pool's rate of every stat: the training players' counters summed (every hand they played).
  const t = sum(villains.flatMap((v) => byVillain.get(v) ?? []), () => false);
  return Object.fromEntries(Object.entries(STATS).map(([name, f]) => {
    const [m, n] = f(t);
    return [name, m / n];
  }));
}

// A candidate: which stat each line reads, and how its parameters map to
// [γ for this line, k, offset c]: δ = γ · (logit(r̂) − logit(p) − c).
const LINES = SRC;
const CANDS = {};
for (const kind of Object.keys(LINE_STAT)) {
  CANDS[kind] = { stat: LINE_STAT[kind], x0: [0.5, Math.log(50)], map: (p) => [p[0], p[1], 0] };
  CANDS[`${kind}+c`] = { stat: LINE_STAT[kind], x0: [0.5, Math.log(50), 0], map: (p) => [p[0], p[1], p[2]] };
  CANDS[`${kind}/line+c`] = {
    stat: LINE_STAT[kind],
    x0: [0.5, 0.5, 0.5, 0.5, 0.5, Math.log(50), 0],
    map: (p, r) => [p[LINES.indexOf(r.source)], p[5], p[6]],
  };
  // The big blind's defence alone; every other line stays on the population.
  CANDS[`${kind}/bb+c`] = {
    stat: LINE_STAT[kind],
    x0: [0.5, Math.log(50), 0],
    map: (p, r) => [r.source === "bb-defence" ? p[0] : 0, p[1], p[2]],
  };
  // The same with k fixed (FIXK, the shipped rule's prior weight): γ and c fitted.
  CANDS[`${kind}/bb+c k`] = {
    stat: LINE_STAT[kind],
    x0: [0.5, 0],
    map: (p, r) => [r.source === "bb-defence" ? p[0] : 0, Math.log(Number(process.env.FIXK ?? 15)), p[1]],
  };
}
if (process.env.KINDS) for (const k of Object.keys(CANDS)) if (!process.env.KINDS.split(",").includes(k)) delete CANDS[k];

function shift(r, kind, params, pool) {
  const cand = CANDS[kind];
  const stat = cand.stat[r.source];
  const [made, chances] = STATS[stat](r.stats);
  if (!(chances > 0) || chances < MIN) return 0;
  const [gamma, logK, c] = cand.map(params, r);
  const k = Math.exp(logK);
  const p = pool[stat];
  const rhat = (made + k * p) / (chances + k);
  return gamma * (logit(clamp(rhat)) - logit(clamp(p)) - c);
}

const popRange = (r, pop, delta) => {
  const base = CANDIDATES["shape-pooled"].range(r, pop);
  if (!delta) return base;
  return base.map((w) => sig(logit(Math.min(1 - 1e-9, Math.max(1e-9, w))) + delta));
};

function nm1(f, x0, step) {
  const n = x0.length;
  let pts = [x0.slice()];
  for (let i = 0; i < n; i++) { const q = x0.slice(); q[i] += step; pts.push(q); }
  let vals = pts.map(f);
  for (let it = 0; it < 250 * n; it++) {
    const o = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = o.map((i) => pts[i]);
    vals = o.map((i) => vals[i]);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
    const xr = c.map((v, j) => 2 * v - pts[n][j]);
    const fr = f(xr);
    if (fr < vals[0]) {
      const xe = c.map((v, j) => 3 * v - 2 * pts[n][j]);
      const fe = f(xe);
      [pts[n], vals[n]] = fe < fr ? [xe, fe] : [xr, fr];
    } else if (fr < vals[n - 1]) [pts[n], vals[n]] = [xr, fr];
    else {
      const xc = c.map((v, j) => (v + pts[n][j]) / 2);
      const fc = f(xc);
      if (fc < vals[n]) [pts[n], vals[n]] = [xc, fc];
      else for (let i = 1; i <= n; i++) { pts[i] = pts[i].map((v, j) => (v + pts[0][j]) / 2); vals[i] = f(pts[i]); }
    }
    if (Math.abs(vals[n] - vals[0]) < 1e-8) break;
  }
  return pts[0];
}

const KINDS = Object.keys(CANDS);
const folds = (r) => parseInt(r.villain.slice(0, 8), 16) % 5;
const out = { population: [] };
for (const kind of KINDS) out[kind] = [];
const fitted = Object.fromEntries(KINDS.map((k) => [k, []]));
for (const f of [0, 1, 2, 3, 4]) {
  const test = rs.filter((r) => folds(r) === f);
  const train = rs.filter((r) => folds(r) !== f);
  const bias = biasFrom(rows.filter((r) => folds(r) !== f));
  const pop = fit(CANDIDATES["shape-pooled"], train, bias);
  const trainVillains = [...new Set(perHand.map((s) => s.villain))].filter((v) => parseInt(v.slice(0, 8), 16) % 5 !== f);
  const pool = poolRates(trainVillains);
  for (const r of test) out.population.push({ r, w: popRange(r, pop, 0) });
  for (const kind of KINDS) {
    // γ and k on the training players' shown hands (through the bias, unweighted: the score is unweighted).
    const loss = (p) => {
      const logK = CANDS[kind].map(p, train[0])[1];
      if (logK < 0 || logK > Math.log(5000)) return 1e9;
      let tot = 0;
      for (const r of train) tot += llMix(popRange(r, pop, shift(r, kind, p, pool)).map((v, k) => v * bias[k]), r.shown, 0.05);
      return -tot / train.length;
    };
    const p = nm1(loss, CANDS[kind].x0, 0.5);
    fitted[kind].push(p);
    for (const r of test) out[kind].push({ r, w: popRange(r, pop, shift(r, kind, p, pool)), d: shift(r, kind, p, pool) });
  }
}

function clusterSe(diffs, villains) {
  const n = diffs.length;
  const m = diffs.reduce((a, b) => a + b, 0) / n;
  const g = new Map();
  for (let i = 0; i < n; i++) g.set(villains[i], (g.get(villains[i]) ?? 0) + diffs[i] - m);
  let s = 0;
  for (const v of g.values()) s += v * v;
  return [m, Math.sqrt((g.size / Math.max(1, g.size - 1)) * s) / n];
}
const key = (o) => `${o.r.h}:${o.r.villain}`;
const base = new Map(out.population.map((o) => [key(o), o]));
console.log(`mode ${MODE}, min ${MIN}; ${rs.length} shown hands, ${new Set(rs.map((r) => r.villain)).size} players`);
for (const kind of KINDS) {
  const ps = fitted[kind].map((p) => p.map((x) => x.toFixed(2)).join(" ")).join(" | ");
  console.log(`\n=== ${kind}: ${ps}`);
  for (const sub of ["all", ...SRC]) {
    const list = out[kind].filter((o) => sub === "all" || o.r.source === sub);
    const b = list.map((o) => base.get(key(o)));
    const v = list.map((o) => o.r.villain);
    const llA = list.map((o) => ll(o.w, o.r.shown));
    const llB = b.map((o) => ll(o.w, o.r.shown));
    const mxA = list.map((o) => llMix(o.w, o.r.shown));
    const mxB = b.map((o) => llMix(o.w, o.r.shown));
    const [d, se] = clusterSe(llA.map((x, i) => x - llB[i]), v);
    const [dm, sem] = clusterSe(mxA.map((x, i) => x - mxB[i]), v);
    const wt = list.map((o) => o.r.wt ?? 1);
    const W = wt.reduce((a, x) => a + x, 0);
    const wd = llA.reduce((a, x, i) => a + wt[i] * (x - llB[i]), 0) / W;
    const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
    const width = mean(list.map((o) => combos(o.w)));
    const widthB = mean(b.map((o) => combos(o.w)));
    const moved = list.filter((o) => Math.abs(o.d) > 0.05).length;
    console.log(
      `${sub.padEnd(11)} n ${String(list.length).padStart(4)}  pop ${mean(llB).toFixed(3)}  adj ${mean(llA).toFixed(3)}  Δ ${d.toFixed(3)} ± ${se.toFixed(3)}  mixΔ ${dm.toFixed(3)} ± ${sem.toFixed(3)}  weighted Δ ${wd.toFixed(3)}  width ${widthB.toFixed(0)} → ${width.toFixed(0)}  |δ|>0.05: ${moved}`,
    );
  }
}
// The chances behind each held-out hand's stat (what a minimum sample would cut).
const ch = rs.map((r) => r.stats.vpip_opp).sort((a, b) => a - b);
const q = (x) => ch[Math.floor(x * (ch.length - 1))];
console.log(`\nvpip chances behind a shown hand: min ${q(0)}, 10% ${q(0.1)}, median ${q(0.5)}, 90% ${q(0.9)}, max ${q(1)}`);

// FIT_ALL=1: the shipped rule's parameters, fitted on every shown hand
// against the shipped population (`population/1`'s 14 numbers), with the
// pool rates of every opponent in the library.
if (process.env.FIT_ALL === "1") {
  const POPULATION_1 = [-0.443, 1.609, 1.578, 1.046, 1.105, -1.779, 2.221, 0.18, -3.071, -0.693, -0.343, 0.095, 0.294, 0.023];
  const bias = biasFrom(rows);
  const pool = poolRates([...byVillain.keys()]);
  for (const kind of KINDS) {
    const loss = (p) => {
      let tot = 0;
      for (const r of rs) tot += llMix(popRange(r, POPULATION_1, shift(r, kind, p, pool)).map((v, k) => v * bias[k]), r.shown, 0.05);
      return -tot / rs.length;
    };
    const p = nm1(loss, CANDS[kind].x0, 0.5);
    const rates = Object.fromEntries(Object.entries(pool).map(([a, b]) => [a, Number(b.toFixed(4))]));
    console.log(`\nFIT_ALL ${kind}: params ${p.map((x) => x.toFixed(3)).join(" ")}; pool ${JSON.stringify(rates)}`);
  }
}
