"use client";

/**
 * EN / HR. The choice is a cookie; the server renders the next request in it,
 * so switching is "remember, then refresh" and no component has to listen.
 *
 * Each language is named in itself — "English", "Hrvatski" — never translated:
 * a reader who landed in the wrong language has to be able to find their own.
 */

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { rememberLocale, useDict, useLocale } from "../../lib/i18n/client";
import { LOCALES, type Locale } from "../../lib/i18n/types";

const NAMES: Record<Locale, { short: string; long: string }> = {
  en: { short: "EN", long: "English" },
  hr: { short: "HR", long: "Hrvatski" },
};

export function LanguageSwitch({ variant = "compact" }: { variant?: "compact" | "full" }) {
  const en = useDict();
  const current = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(locale: Locale) {
    if (locale === current) return;
    rememberLocale(locale);
    startTransition(() => router.refresh());
  }

  return (
    <div className={`langswitch langswitch--${variant}`} role="group" aria-label={en.language.label} aria-busy={pending}>
      {LOCALES.map((locale) => (
        <button
          key={locale}
          type="button"
          lang={locale}
          className={`langswitch__option${locale === current ? " is-active" : ""}`}
          aria-pressed={locale === current}
          title={NAMES[locale].long}
          onClick={() => choose(locale)}
        >
          {variant === "full" ? NAMES[locale].long : NAMES[locale].short}
        </button>
      ))}
    </div>
  );
}
