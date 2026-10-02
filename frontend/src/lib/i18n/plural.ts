/**
 * Croatian plural: one (1, 21, 31…), few (2–4, 22–24…), many (everything
 * else — 0, 5–20, 25–30, and 11–14 in every hundred). A module of its own so
 * the namespace files can import it without a cycle through `hr.ts`.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(count) % 100;
  const last = n % 10;
  if (last === 1 && n !== 11) return one;
  if (last >= 2 && last <= 4 && (n < 12 || n > 14)) return few;
  return many;
}
