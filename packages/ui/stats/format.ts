/**
 * Number formatters for the statistics components, in the reader's locale
 * (`UiStrings.intlLocale`). Presentation only: no arithmetic.
 *
 * One `Intl.NumberFormat` per locale and options, shared with the web's own
 * statistics screens (`web/src/components/stats/format.ts` re-exports
 * these), so a page builds each formatter once.
 */

const numberFormats = new Map<string, Intl.NumberFormat>();

/** One `Intl.NumberFormat` per locale and options, built on first use. */
export function numberFormat(locale: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

/** A whole-number formatter for `locale`: "1,234" / "1.234". */
export const countIn = (locale: string) => (value: number) => numberFormat(locale).format(value);

/**
 * A fixed number of decimals, without grouping — the locale's decimal mark in
 * place of `toFixed`, and otherwise the same digits.
 */
export const fixedIn = (locale: string, digits: number) => (value: number) =>
  numberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(
    value,
  );

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** One `Intl.DateTimeFormat` per locale and options, built on first use. */
export function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    dateFormats.set(key, format);
  }
  return format;
}
