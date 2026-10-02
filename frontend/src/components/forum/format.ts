/**
 * `2026-09-29T08:02:17Z` -> `29 Sep 2026` (or `29. ruj 2026.`), in UTC so
 * server and client agree. `intl` is the reader's `chrome.intl`.
 */
export function formatPostDate(iso: string, intl: string = "en-GB"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(intl, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}
