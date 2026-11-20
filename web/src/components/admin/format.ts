"use client";

import { useMemo } from "react";
import { INTL_LOCALE } from "../../lib/i18n/dictionaries";
import { useLocale } from "../../lib/i18n/client";

/** Dates and numbers in the reader's language, for the admin tables. */
export function useAdminFormat() {
  const locale = INTL_LOCALE[useLocale()];
  return useMemo(() => {
    const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
    const dateTime = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
    const number = new Intl.NumberFormat(locale);
    return {
      number: (value: number) => number.format(value),
      date: (iso: string | null) => (iso ? date.format(new Date(iso)) : null),
      dateTime: (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : null),
      /** "3 min ago", "yesterday", "5 days ago"; past a month, the date. */
      ago: (iso: string | null) => {
        if (!iso) return null;
        const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
        const abs = Math.abs(seconds);
        if (abs < 60) return relative.format(Math.round(seconds), "second");
        if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
        if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour");
        if (abs < 30 * 86400) return relative.format(Math.round(seconds / 86400), "day");
        return date.format(new Date(iso));
      },
    };
  }, [locale]);
}

/** Whether a time is still ahead (a ban that has not run out). */
export function isFuture(iso: string | null): boolean {
  return iso !== null && new Date(iso).getTime() > Date.now();
}
