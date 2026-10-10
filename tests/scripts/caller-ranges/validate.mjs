// Caller-range study (analysis/19), held-out validation:
//   CALLERS_OUT=/local/shown.jsonl WEIGHT=1 BIAS=1 [SPLIT=date] \
//     SOURCES="cold-call|bb-defence|first-limp|over-limp|limp-call" node validate.mjs
// Prints, per line, each candidate's mean log-likelihood and its difference to
// the placeholder, the charts, the analysis/18 reading and any two cards, with
// standard errors clustered by player (five folds by player, or two by date).
import { rows } from "./lib.mjs";
import { evaluate } from "./study.mjs";

const SOURCES = (process.env.SOURCES ?? "cold-call,bb-defence,first-limp,over-limp,limp-call").split(",");
const SPLIT = process.env.SPLIT ?? "villain";
const BIAS = process.env.BIAS === "1";
const median = rows.map((r) => r.date).sort()[Math.floor(rows.length / 2)];
const folds =
  SPLIT === "date"
    ? (r) => (r.date < median ? 0 : 1)
    : (r) => parseInt(r.villain.slice(0, 8), 16) % 5;

function clusterSe(diffs, villains) {
  const n = diffs.length;
  const m = diffs.reduce((a, b) => a + b, 0) / n;
  const g = new Map();
  for (let i = 0; i < n; i++) g.set(villains[i], (g.get(villains[i]) ?? 0) + diffs[i] - m);
  const G = g.size;
  let s = 0;
  for (const v of g.values()) s += v * v;
  return [m, Math.sqrt((G / Math.max(1, G - 1)) * s) / n];
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

for (const source of SOURCES) {
  const rs = rows.filter((r) => source.split("|").includes(r.source) && !r.allIn);
  const full = evaluate(rs, folds, { bias: BIAS });
  for (const sub of source.includes("|") ? [source, ...source.split("|")] : [source]) {
  const keep = full.placeholder.src.map((s) => sub === source || s === sub);
  const out = {};
  for (const [name, o] of Object.entries(full)) {
    out[name] = {};
    for (const [key, arr] of Object.entries(o)) out[name][key] = key === "params" ? arr : arr.filter((_, i) => keep[i]);
  }
  const ph = out.placeholder;
  const ch = out.chart;
  console.log(`\n=== ${sub} (n ${out.placeholder.ll.length}, split ${SPLIT}${BIAS ? ", fitted through the showdown bias" : ""})`);
  console.log("candidate          ll      d vs ph (cl.SE)    d vs chart        mix d vs ph      adj d vs ph      hold   width");
  for (const [name, o] of Object.entries(out)) {
    const v = o.villain;
    const [d1, s1] = clusterSe(o.ll.map((x, i) => x - ph.ll[i]), v);
    const [d2, s2] = clusterSe(o.ll.map((x, i) => x - ch.ll[i]), v);
    const [d3, s3] = clusterSe(o.mix.map((x, i) => x - ph.mix[i]), v);
    const [d4, s4] = clusterSe(o.llAdj.map((x, i) => x - ph.llAdj[i]), v);
    const cu = out.current, at = out.atc;
    const [d5, s5] = clusterSe(o.ll.map((x, i) => x - cu.ll[i]), v);
    const [d6, s6] = clusterSe(o.ll.map((x, i) => x - at.ll[i]), v);
    const W = o.wt.reduce((a, b) => a + b, 0);
    const wd = o.ll.reduce((a, x, i) => a + o.wt[i] * (x - ph.ll[i]), 0) / W;
    console.log(
      `${name.padEnd(16)} wΔph ${wd.toFixed(2).padStart(5)} ${mean(o.ll).toFixed(2).padStart(6)}  ${d1.toFixed(2).padStart(6)} ± ${s1.toFixed(2)}     ${d2.toFixed(2).padStart(6)} ± ${s2.toFixed(2)}    ${d3.toFixed(2).padStart(6)} ± ${s3.toFixed(2)}    ${d4.toFixed(2).padStart(6)} ± ${s4.toFixed(2)}    vsCur ${d5.toFixed(2).padStart(5)} ± ${s5.toFixed(2)} vsATC ${d6.toFixed(2).padStart(5)} ± ${s6.toFixed(2)}  ${(100 * mean(o.hold)).toFixed(0).padStart(3)}%  ${mean(o.combos).toFixed(0).padStart(5)}`,
    );
    if (process.env.PARAMS && o.params[0]?.length) console.log("    params", o.params.map((p) => p.map((x) => x.toFixed(2)).join(" ")).join(" | "));
  }
}
}
