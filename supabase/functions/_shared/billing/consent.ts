/**
 * The consent `billing-checkout` requires before it opens Stripe Checkout
 * (docs/RAIL-PLAN.md R6.3 *As built*, "Consent at checkout"; docs/BILLING.md).
 *
 * EU consumer law (Directive 2011/83/EU art. 16(m) as amended; the Croatian
 * Zakon o zaštiti potrošača): Pro starts at once, so the consumer must,
 * **before** it starts, expressly ask for it to start and acknowledge what
 * that does to the right of withdrawal - and the trader must be able to show
 * it. The web's upgrade step shows two unticked checkboxes (both required);
 * the page sends both flags and the version of the wording it showed; this
 * file says which wordings and which terms the server knows, so what is
 * recorded is never taken from the browser beyond "these two boxes, this
 * wording, this language".
 *
 * Not legal advice: the wording is a draft for the owner's and the lawyer's
 * review (`web/src/lib/i18n/ns/plan.*.ts`, `billing.consent`).
 *
 * Changing the wording (Vitest `checkoutConsent` fails until this is done):
 *  1. edit both languages in `plan.en.ts` / `plan.hr.ts` and bump
 *     `CHECKOUT_CONSENT_VERSION` in `web/src/lib/billing/checkout.ts`;
 *  2. add the new version and its hashes to `CONSENT_TEXTS` below - keep the
 *     old one until every open tab has reloaded (a day), so a page from the
 *     last deploy can still buy;
 *  3. deploy `billing-checkout` **before** the web.
 * Changing the terms: update `TERMS` (version and both hashes; the test
 * names them).
 */

/** What the two checkboxes are, in the order the record lists them. */
export const CONSENT_KINDS = ["terms", "immediate_performance"] as const;

export type ConsentLocale = "en" | "hr";

/**
 * Every wording of the two checkboxes the server accepts: version -> the
 * SHA-256 (hex) of the plain statements in each language, the terms line
 * then a newline then the immediate-performance line (`consentStatements` in
 * `web/src/lib/billing/checkout.ts`).
 */
export const CONSENT_TEXTS: Readonly<Record<string, Readonly<Record<ConsentLocale, string>>>> = {
  "2026-10-26": {
    en: "59fb3b11832a810dfdf205883df3d599da43b54693285934ae99eecc3ad232c3",
    hr: "bb7dddcbb57b32d866907c770b65f749280e61f2b7d7395e9ef2a1b421093478",
  },
};

/**
 * The terms the first checkbox links to (`/terms`, `docs/legal/TERMS*.md`):
 * a version the owner names and the SHA-256 of each language's document.
 * While the terms are a draft the version says so.
 */
export const TERMS: Readonly<{ version: string; sha256: Readonly<Record<ConsentLocale, string>> }> = {
  version: "draft-2026-10-26",
  sha256: {
    en: "662b4a378932b6c4b48d7368eca087783a960d034a80bafeb02381d08b5a3ecc",
    hr: "f56396bf85f485505a44a9cb7bbdfc36090a4e24a1779c42d145cfbd68c160a1",
  },
};

/**
 * Shown by Stripe Checkout above its Pay button (`custom_text.submit`), in
 * the page's language: the same request and acknowledgement, at the moment
 * of paying. A reminder, not a second consent (no checkbox there).
 */
export const SUBMIT_MESSAGE: Readonly<Record<ConsentLocale, string>> = {
  en:
    "Rail Pro starts as soon as you pay, at your request. You have acknowledged that you lose your right of withdrawal once it has started.",
  hr:
    "Rail Pro počinje čim platiš, na tvoj zahtjev. Potvrđuješ da time gubiš pravo na jednostrani raskid ugovora nakon što počne.",
};

export interface CheckoutConsent {
  kinds: string[];
  locale: ConsentLocale;
  textVersion: string;
  textSha256: string;
  termsVersion: string;
  termsSha256: string;
}

export type ConsentResult =
  | { ok: true; consent: CheckoutConsent }
  | { ok: false; error: "consent_required" | "consent_outdated" | "invalid_request"; detail: string };

/**
 * The body's `consent` and `locale`: both boxes exactly `true`, a wording
 * this server knows, and the language it was shown in (`en` or `hr` - the
 * record names the text the person read).
 */
export function readConsent(body: { consent?: unknown; locale?: unknown }): ConsentResult {
  const raw = body.consent;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "consent_required", detail: "no consent" };
  }
  const consent = raw as { terms?: unknown; immediatePerformance?: unknown; version?: unknown };
  if (consent.terms !== true || consent.immediatePerformance !== true) {
    return { ok: false, error: "consent_required", detail: "a box not ticked" };
  }
  if (body.locale !== "en" && body.locale !== "hr") {
    return { ok: false, error: "invalid_request", detail: "locale" };
  }
  const version = consent.version;
  if (typeof version !== "string" || !Object.hasOwn(CONSENT_TEXTS, version)) {
    return { ok: false, error: "consent_outdated", detail: "unknown wording" };
  }
  return {
    ok: true,
    consent: {
      kinds: [...CONSENT_KINDS],
      locale: body.locale,
      textVersion: version,
      textSha256: CONSENT_TEXTS[version][body.locale],
      termsVersion: TERMS.version,
      termsSha256: TERMS.sha256[body.locale],
    },
  };
}
