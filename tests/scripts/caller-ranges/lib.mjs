// Caller-range study (analysis/19), shared helpers: reads the extract step's
// LOCAL JSONL (CALLERS_OUT) and scores a range on a shown hand - the mean
// log-likelihood per combo of analysis/17-18 (a hand outside the range at a
// twentieth of a uniform combo), and a proper 95/5 mixture with uniform.
import { readFileSync } from "node:fs";
const FILE = process.env.CALLERS_OUT ?? "";
if (!FILE) throw new Error("CALLERS_OUT (the extract step's local JSONL) must be set");
export const NAMES = JSON.parse(readFileSync(`${FILE}.classes.json`, "utf8"));
export const COMBOS = NAMES.map((n) => (n.length === 2 ? 6 : n.endsWith("s") ? 4 : 12));
export const rows = readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
export const FLOOR = Math.log(1 / (20 * 1326));

/** #129 metric: ln(w_k / sum w*combos), or a twentieth of a uniform combo outside the range. */
export function ll(range, k) {
  if (!range) return null;
  let tot = 0;
  for (let i = 0; i < 169; i++) tot += range[i] * COMBOS[i];
  if (!(tot > 0) || !(range[k] > 0)) return FLOOR;
  return Math.max(FLOOR, Math.log(range[k] / tot));
}
/** Proper mixture: 95% the range, 5% uniform. */
export function llMix(range, k, eps = 0.05) {
  let tot = 0;
  for (let i = 0; i < 169; i++) tot += range[i] * COMBOS[i];
  const p = tot > 0 ? range[k] / tot : 0;
  return Math.log((1 - eps) * p + eps / 1326);
}
export const combos = (range) => range.reduce((s, w, i) => s + w * COMBOS[i], 0);
export const chartRangeOf = (node) => (node ? node.range.map((r, k) => r * node.freq[node.chosen * 169 + k]) : null);
export const ATC = new Array(169).fill(1);

export function meanSe(xs) {
  const n = xs.length;
  if (!n) return [NaN, NaN, 0];
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1);
  return [m, Math.sqrt(v / n), n];
}
export const fmt = ([m, se, n]) => `${m.toFixed(2)} ± ${se.toFixed(2)} (n ${n})`;
/** Paired difference a - b. */
export const paired = (a, b) => meanSe(a.map((x, i) => x - b[i]));
