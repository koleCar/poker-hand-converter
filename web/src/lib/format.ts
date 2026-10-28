/** Compact money formatting shared by the table, the list and the controls. */
export function formatMoney(currency: string, amount: number): string {
  if (Math.abs(amount) >= 1000) {
    const thousands = amount / 1000;
    return `${currency}${thousands.toFixed(thousands % 1 === 0 ? 0 : 1)}k`;
  }
  return `${currency}${amount % 1 === 0 ? amount : amount.toFixed(2)}`;
}

/**
 * A frequency (0..1) as the percent to print, the number left to the
 * caller's locale: one decimal under 10% and over 90%, whole between, so a
 * 95.5% fold sits beside a 4.5% call rather than a 96% one. Only exactly 0 and
 * 1 read 0% and 100%: anything that would round there reads `<0.1%` or
 * `>99.9%` (`bound`).
 */
export function shownPercent(freq: number): { value: number; digits: 0 | 1; bound: "<" | ">" | null } {
  if (freq <= 0) return { value: 0, digits: 0, bound: null };
  if (freq >= 1) return { value: 100, digits: 0, bound: null };
  const p = freq * 100;
  const tenth = Math.round(p * 10) / 10;
  if (tenth >= 10 && tenth <= 90) return { value: Math.round(p), digits: 0, bound: null };
  if (tenth <= 0) return { value: 0.1, digits: 1, bound: "<" };
  if (tenth >= 100) return { value: 99.9, digits: 1, bound: ">" };
  return { value: tenth, digits: 1, bound: null };
}
