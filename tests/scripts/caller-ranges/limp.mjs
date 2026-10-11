// Per-villain limp study (analysis/21 candidates, ANALYSIS-PLAN §10
// 2026-10-11): do a villain's own limp statistics - counted from the learner's
// library without the held-out hand - widen or narrow the population ranges
// (`population/1`) of their limps and limp-calls usefully? `analysis/20`
// found VPIP − PFR, VPIP and the overall limp frequency did not.
//
//   CALLERS_OUT=/local/shown.jsonl WEIGHT=1 [STATS=loo|prior] [FIXK=15] [MIN=30] node limp.mjs
//
// Reads the extract step's LOCAL files (`shown.jsonl`, `shown.jsonl.stats.jsonl`
// with the limp counters of `limpCounters.ts`). Same method as `villain.mjs`:
// five folds by player; in each, the population shape is fitted on the other
// players (through the showdown bias, weighted), the adjustment's parameters
// on the other players' shown limps, and every held-out shown hand is scored
// with its player's statistics counted over their OTHER hands (STATS=loo) or
// only the hands before it (STATS=prior). The line's logit moves by
//     δ = γ[line] · (logit(r̂) − logit(p) − c),   r̂ = (made + k·p) / (chances + k)
// p the training players' pool rate (per position group for `pos`), nothing
// unless the player has at least MIN hands (`vpip_opp`, the shipped rule of
// villain/1) and the stat at least one chance. Forms per statistic: `one` (one
// γ, c = 0), `line` (γ per line), `fl+c` / `ol+c` / `lc+c` (one line alone, γ
// and c, the form villain/1 shipped for the big blind), `line+c` (γ per line,
// one c), `tilt` (δ[class] = u · (γ0 + γ1 · z[class]), z the class's
// standardised logit: stronger or weaker hands, not only more). KINDS=a,b
// keeps the candidates whose name contains a or b. Prints, per candidate and
// line, the mean log-likelihood per combo against population-only, standard
// errors clustered by player, and a summary table. Result (2026-10-11): no
// candidate beats population-only - nothing shipped (ANALYSIS-PLAN §10).
import { readFileSync } from "node:fs";
import { rows, ll, llMix, combos } from "./lib.mjs";
import { CANDIDATES, biasFrom, fit } from "./study.mjs";

const SRC = ["cold-call", "bb-defence", "first-limp", "over-limp", "limp-call"];
const LIMP = ["first-limp", "over-limp", "limp-call"];
const MODE = process.env.STATS ?? "loo";
const MIN = Number(process.env.MIN ?? 30);
const FIXK = process.env.FIXK ? Number(process.env.FIXK) : null;
const sig = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(p / (1 - p));
const clamp = (p) => Math.min(0.995, Math.max(0.005, p));
const GROUP = { UTG: "EP", "UTG+1": "EP", "UTG+2": "EP", MP: "MP", LJ: "MP", HJ: "MP", CO: "LP", BTN: "LP", SB: "SB" };

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
const sum = (list, skip) => {
  const t = {};
  for (const s of list) {
    if (skip(s)) continue;
    for (const [k, v] of Object.entries(s.c)) t[k] = (t[k] ?? 0) + v;
  }
  return t;
};
const rs = rows.filter((r) => SRC.includes(r.source) && !r.allIn);
for (const r of rs) {
  const list = byVillain.get(r.villain) ?? [];
  r.stats = MODE === "prior" ? sum(list, (s) => !(s.date < r.date)) : sum(list, (s) => s.h === r.h);
}
const g = (t, k) => t[k] ?? 0;

/* ---------- the statistics: [made, chances] of a villain's counters (and the row, for its position) ---------- */
const STATS = {
  limpAny: (t) => [g(t, "limp"), g(t, "limp_opp")],
  passive: (t) => [g(t, "vpip") - g(t, "pfr"), g(t, "vpip_opp")],
  openLimp: (t) => [g(t, "lo_EP") + g(t, "lo_MP") + g(t, "lo_LP"), g(t, "lo_opp_EP") + g(t, "lo_opp_MP") + g(t, "lo_opp_LP")],
  openLimpSB: (t) => [g(t, "lo_EP") + g(t, "lo_MP") + g(t, "lo_LP") + g(t, "lo_SB"), g(t, "lo_opp_EP") + g(t, "lo_opp_MP") + g(t, "lo_opp_LP") + g(t, "lo_opp_SB")],
  EP: (t) => [g(t, "lo_EP"), g(t, "lo_opp_EP")],
  MP: (t) => [g(t, "lo_MP"), g(t, "lo_opp_MP")],
  LP: (t) => [g(t, "lo_LP"), g(t, "lo_opp_LP")],
  SB: (t) => [g(t, "lo_SB"), g(t, "lo_opp_SB")],
  overLimp: (t) => [g(t, "ol"), g(t, "ol_opp")],
  limpFold: (t) => [g(t, "lf"), g(t, "lr_opp")],
  limpCall: (t) => [g(t, "lc"), g(t, "lr_opp")],
  limpRaise: (t) => [g(t, "lr"), g(t, "lr_opp")],
  // How often a player who enters first in, or behind limpers, limps rather than raises.
  limpShare: (t) => {
    const limps = g(t, "lo_EP") + g(t, "lo_MP") + g(t, "lo_LP") + g(t, "ol");
    return [limps, limps + g(t, "rfi") + g(t, "iso")];
  },
};
// The open-limp frequency in the shown hand's own position group.
const statOf = (name, r) => (name === "pos" ? GROUP[r.position] ?? null : name);

// Which stat each limp line reads, per candidate (cold calls and the big blind stay on the population).
const same = (s) => ({ "first-limp": s, "over-limp": s, "limp-call": s });
const LINE_STAT = {
  limpAny: same("limpAny"),
  passive: same("passive"),
  openLimp: same("openLimp"),
  openLimpSB: same("openLimpSB"),
  pos: same("pos"),
  overLimp: same("overLimp"),
  limpFold: same("limpFold"),
  limpCall: same("limpCall"),
  limpRaise: same("limpRaise"),
  limpShare: same("limpShare"),
  // Each line on its own stat: a first limp on the open-limp rate in its position, an over-limp on the over-limp rate, a limp-call on the limp-call rate.
  natural: { "first-limp": "pos", "over-limp": "overLimp", "limp-call": "limpCall" },
  naturalFold: { "first-limp": "pos", "over-limp": "overLimp", "limp-call": "limpFold" },
};

function poolRates(villains) {
  const t = sum(villains.flatMap((v) => byVillain.get(v) ?? []), () => false);
  return Object.fromEntries(Object.entries(STATS).map(([name, f]) => {
    const [m, n] = f(t);
    return [name, n > 0 ? m / n : 0.5];
  }));
}

// A candidate's parameters → [γ for the row's line, log k, c].
const CANDS = {};
const K0 = FIXK === null ? [Math.log(15)] : [];
const logKOf = (p, i) => (FIXK === null ? p[i] : Math.log(FIXK));
for (const kind of Object.keys(LINE_STAT)) {
  // One γ for the three limp lines, no offset: the fewest parameters.
  CANDS[`${kind}/one`] = {
    stat: LINE_STAT[kind],
    x0: [0.5, ...K0],
    map: (p, r) => [LIMP.includes(r.source) ? p[0] : 0, logKOf(p, 1), 0],
  };
  // γ per line, no offset.
  CANDS[`${kind}/line`] = {
    stat: LINE_STAT[kind],
    x0: [0.5, 0.5, 0.5, ...K0],
    map: (p, r) => {
      const i = LIMP.indexOf(r.source);
      return [i < 0 ? 0 : p[i], logKOf(p, 3), 0];
    },
  };
  // One line alone, γ and c (the form villain/1 shipped for the big blind); the other two stay on the population.
  for (const [tag, line] of [["fl", "first-limp"], ["ol", "over-limp"], ["lc", "limp-call"]]) {
    CANDS[`${kind}/${tag}+c`] = {
      stat: LINE_STAT[kind],
      x0: [0.5, 0, ...K0],
      map: (p, r) => [r.source === line ? p[0] : 0, logKOf(p, 2), p[1]],
    };
  }
  // A tilt instead of a widening: δ[class] = u · (γ0 + γ1 · z[class]), z the class's standardised
  // logit in the population range, u = logit(r̂) − logit(p): a player who limps what others raise
  // (limpShare) should limp stronger hands, not only more of them.
  CANDS[`${kind}/tilt`] = {
    stat: LINE_STAT[kind],
    x0: [0.5, 0, ...K0],
    map: (p, r) => [LIMP.includes(r.source) ? p[0] : 0, logKOf(p, 2), 0, LIMP.includes(r.source) ? p[1] : 0],
  };
  // γ per line and an offset c.
  CANDS[`${kind}/line+c`] = {
    stat: LINE_STAT[kind],
    x0: FIXK === null ? [0.5, 0.5, 0.5, Math.log(15), 0] : [0.5, 0.5, 0.5, 0],
    map: (p, r) => {
      const i = LIMP.indexOf(r.source);
      return FIXK === null ? [i < 0 ? 0 : p[i], p[3], p[4]] : [i < 0 ? 0 : p[i], Math.log(FIXK), p[3]];
    },
  };
}
if (process.env.KINDS) for (const k of Object.keys(CANDS)) if (!process.env.KINDS.split(",").some((x) => k.includes(x))) delete CANDS[k];

function shift(r, kind, params, pool) {
  const cand = CANDS[kind];
  if (!LIMP.includes(r.source)) return 0;
  if (!(g(r.stats, "vpip_opp") >= MIN)) return 0;
  const stat = statOf(cand.stat[r.source], r);
  if (!stat) return 0;
  const [made, chances] = STATS[stat](r.stats);
  if (!(chances > 0)) return 0;
  const [gamma, logK, c, tilt] = cand.map(params, r);
  const k = Math.exp(logK);
  const p = pool[stat];
  const rhat = (made + k * p) / (chances + k);
  const u = logit(clamp(rhat)) - logit(clamp(p)) - c;
  return tilt ? { a: gamma * u, b: tilt * u } : gamma * u;
}

const lg = (w) => logit(Math.min(1 - 1e-9, Math.max(1e-9, w)));
/** δ a number (every class alike) or { a, b }: δ[class] = a + b · z[class]. */
function shiftRange(base, delta) {
  if (!delta) return base;
  if (typeof delta === "number") return base.map((w) => sig(lg(w) + delta));
  const z = base.map(lg);
  const m = z.reduce((s, x) => s + x, 0) / z.length;
  const sd = Math.sqrt(z.reduce((s, x) => s + (x - m) ** 2, 0) / z.length) || 1;
  return base.map((w, i) => sig(z[i] + delta.a + (delta.b * (z[i] - m)) / sd));
}
const size = (d) => (typeof d === "number" ? Math.abs(d) : Math.abs(d.a) + Math.abs(d.b));

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
  const test = rs.filter((r) => folds(r) === f && LIMP.includes(r.source));
  const train = rs.filter((r) => folds(r) !== f);
  const trainLimp = train.filter((r) => LIMP.includes(r.source));
  const bias = biasFrom(rows.filter((r) => folds(r) !== f));
  const pop = fit(CANDIDATES["shape-pooled"], train, bias);
  const trainVillains = [...byVillain.keys()].filter((v) => parseInt(v.slice(0, 8), 16) % 5 !== f);
  const pool = poolRates(trainVillains);
  const base = new Map([...trainLimp, ...test].map((r) => [r, CANDIDATES["shape-pooled"].range(r, pop)]));
  for (const r of test) out.population.push({ r, w: base.get(r), d: 0 });
  for (const kind of KINDS) {
    const loss = (p) => {
      const logK = CANDS[kind].map(p, trainLimp[0])[1];
      if (logK < 0 || logK > Math.log(5000)) return 1e9;
      let tot = 0;
      for (const r of trainLimp) tot += llMix(shiftRange(base.get(r), shift(r, kind, p, pool)).map((v, k) => v * bias[k]), r.shown, 0.05);
      return -tot / trainLimp.length;
    };
    const p = nm1(loss, CANDS[kind].x0, 0.5);
    fitted[kind].push(p);
    for (const r of test) {
      const d = shift(r, kind, p, pool);
      out[kind].push({ r, w: shiftRange(base.get(r), d), d });
    }
  }
}

function clusterSe(diffs, villains) {
  const n = diffs.length;
  const m = diffs.reduce((a, b) => a + b, 0) / n;
  const gr = new Map();
  for (let i = 0; i < n; i++) gr.set(villains[i], (gr.get(villains[i]) ?? 0) + diffs[i] - m);
  let s = 0;
  for (const v of gr.values()) s += v * v;
  return [m, Math.sqrt((gr.size / Math.max(1, gr.size - 1)) * s) / n];
}
const key = (o) => `${o.r.h}:${o.r.villain}`;
const baseOf = new Map(out.population.map((o) => [key(o), o]));
const lim = rs.filter((r) => LIMP.includes(r.source));
console.log(`mode ${MODE}, min ${MIN} hands, k ${FIXK ?? "fitted"}; ${lim.length} shown limps, ${new Set(lim.map((r) => r.villain)).size} players; ${lim.filter((r) => g(r.stats, "vpip_opp") >= MIN).length} with ≥${MIN} hands`);
const summary = [];
for (const kind of KINDS) {
  const ps = fitted[kind].map((p) => p.map((x) => x.toFixed(2)).join(" ")).join(" | ");
  console.log(`\n=== ${kind}: ${ps}`);
  for (const sub of ["limps", ...LIMP]) {
    const list = out[kind].filter((o) => sub === "limps" || o.r.source === sub);
    const b = list.map((o) => baseOf.get(key(o)));
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
    const moved = list.filter((o) => size(o.d) > 0.05).length;
    console.log(
      `${sub.padEnd(11)} n ${String(list.length).padStart(4)}  pop ${mean(llB).toFixed(3)}  adj ${mean(llA).toFixed(3)}  Δ ${d.toFixed(3)} ± ${se.toFixed(3)}  mixΔ ${dm.toFixed(3)} ± ${sem.toFixed(3)}  weighted Δ ${wd.toFixed(3)}  width ${widthB.toFixed(0)} → ${width.toFixed(0)}  |δ|>0.05: ${moved}`,
    );
    summary.push({ kind, sub, d, se });
  }
}
console.log("\nsummary (Δ ± SE per combo against population-only):");
console.log(`${"candidate".padEnd(22)} ${["limps", ...LIMP].map((s) => s.padStart(16)).join("")}`);
for (const kind of KINDS) {
  console.log(`${kind.padEnd(22)} ${["limps", ...LIMP].map((s) => {
    const x = summary.find((y) => y.kind === kind && y.sub === s);
    return `${x.d >= 0 ? "+" : ""}${x.d.toFixed(3)} ± ${x.se.toFixed(3)}`.padStart(16);
  }).join("")}`);
}
