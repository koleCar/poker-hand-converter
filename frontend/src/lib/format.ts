/** Compact money formatting shared by the table, the list and the controls. */
export function formatMoney(currency: string, amount: number): string {
  if (Math.abs(amount) >= 1000) {
    const thousands = amount / 1000;
    return `${currency}${thousands.toFixed(thousands % 1 === 0 ? 0 : 1)}k`;
  }
  return `${currency}${amount % 1 === 0 ? amount : amount.toFixed(2)}`;
}
