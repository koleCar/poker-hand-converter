/**
 * The consent before Stripe Checkout (Rail R6.3 addendum; EU consumer law,
 * Directive 2011/83/EU art. 16(m), the Croatian ZZP):
 *
 * - the upgrade step's two checkboxes, unticked, both required, the terms
 *   linked, Checkout offered only with both ticked - in English and Croatian;
 * - the page never asks the function without both (`startCheckout`);
 * - the wording the page shows is the wording the server records: the
 *   version the page sends is one `billing-checkout` knows, and the hash
 *   the server stores for it is the hash of these exact words (change a word
 *   without a new version and this fails);
 * - the terms the server names are the documents at `/terms` (their hash);
 * - Stripe's reminder above its Pay button fits Stripe's limit;
 * - the success page repeats the confirmation, and the refusals are worded.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CHECKOUT_CONSENT_VERSION,
  consentComplete,
  consentStatements,
  NO_CONSENT,
  parseBillingOffer,
  startCheckout,
} from "../../frontend/src/lib/billing/checkout.js";
import { ConsentFields, UpgradeChooser } from "../../frontend/src/components/plan/PlanPanel.js";
import { BillingSuccessView } from "../../frontend/src/components/plan/BillingReturn.js";
import { I18nProvider } from "../../frontend/src/lib/i18n/client.js";
import { planEn } from "../../frontend/src/lib/i18n/ns/plan.en.js";
import { planHr } from "../../frontend/src/lib/i18n/ns/plan.hr.js";
import { LEGAL_TEXTS } from "../../frontend/src/lib/legal/texts.generated.js";
import {
  CONSENT_KINDS,
  CONSENT_TEXTS,
  readConsent,
  SUBMIT_MESSAGE,
  TERMS,
} from "../../supabase/functions/_shared/billing/consent.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const docs = new URL("../../docs/legal/", import.meta.url);

const OFFER = parseBillingOffer({
  available: true,
  prices: {
    month: { amount: 699, currency: "eur", interval: "month", taxInclusive: true },
    year: { amount: 5999, currency: "eur", interval: "year", taxInclusive: true },
  },
  earlyDiscountPercent: null,
});

const render = (locale: "en" | "hr", node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale }, node));
const chooser = (locale: "en" | "hr", initialConsent = NO_CONSENT) =>
  render(locale, createElement(UpgradeChooser, { offer: OFFER, earlyUser: false, enforced: true, initialConsent }));
const upgradeButton = (html: string) => /<button type="button" class="btn btn--primary"[^>]*>[^<]*<\/button>/.exec(html)?.[0] ?? "";
const checkboxes = (html: string) => html.match(/<input type="checkbox"[^>]*>/g) ?? [];

describe("the upgrade step's consent", () => {
  it("two unticked, required checkboxes; the terms linked; Checkout disabled until both are ticked (English)", () => {
    const html = chooser("en");
    const boxes = checkboxes(html);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box).toContain("required");
      expect(box).not.toContain("checked");
    }
    expect(html).toContain("Before you pay");
    expect(html).toMatch(/I agree to the <a [^>]*href="\/terms"[^>]*>Terms of Use<\/a>/);
    expect(html).toContain('target="_blank"');
    expect(html).toContain(
      "I ask for Rail Pro to start immediately and I acknowledge that I thereby lose my right of withdrawal once it has started.",
    );
    expect(upgradeButton(html)).toContain("disabled");
    expect(upgradeButton(html)).toContain('aria-describedby="plan-consent-required"');
    expect(html).toContain("Tick both boxes to continue to payment.");
  });

  it("one box is not enough; both enable Checkout", () => {
    for (const one of [
      { terms: true, immediatePerformance: false },
      { terms: false, immediatePerformance: true },
    ]) {
      const html = chooser("en", one);
      expect(checkboxes(html).filter((b) => b.includes("checked"))).toHaveLength(1);
      expect(upgradeButton(html)).toContain("disabled");
    }
    const both = chooser("en", { terms: true, immediatePerformance: true });
    expect(checkboxes(both).filter((b) => b.includes("checked"))).toHaveLength(2);
    expect(upgradeButton(both)).not.toContain("disabled");
    expect(upgradeButton(both)).toContain("Upgrade to Pro");
    expect(both).not.toContain("Tick both boxes");
  });

  it("speaks Croatian", () => {
    const html = chooser("hr");
    expect(checkboxes(html)).toHaveLength(2);
    expect(html).toContain("Prije plaćanja");
    expect(html).toMatch(/Prihvaćam <a [^>]*href="\/terms"[^>]*>Uvjete korištenja<\/a>/);
    expect(html).toContain(
      "Tražim da Rail Pro počne odmah i potvrđujem da time gubim pravo na jednostrani raskid ugovora nakon što počne.",
    );
    expect(html).toContain("Za nastavak na plaćanje označi oba polja.");
    expect(upgradeButton(html)).toContain("disabled");
    expect(html).not.toContain("Terms of Use");
    const both = chooser("hr", { terms: true, immediatePerformance: true });
    expect(upgradeButton(both)).not.toContain("disabled");
    expect(upgradeButton(both)).toContain("Prijeđi na Pro");
  });

  it("the boxes are disabled while the payment page opens", () => {
    const html = render(
      "en",
      createElement(ConsentFields, { consent: NO_CONSENT, disabled: true, onChange: () => undefined }),
    );
    expect(html).toMatch(/<fieldset[^>]*disabled/);
  });

  it("the page never asks for a session without both boxes", async () => {
    expect(consentComplete(NO_CONSENT)).toBe(false);
    expect(consentComplete({ terms: true, immediatePerformance: false })).toBe(false);
    expect(consentComplete({ terms: true, immediatePerformance: true })).toBe(true);
    expect(await startCheckout("month", "en", NO_CONSENT)).toEqual({ ok: false, error: "consent_required" });
    expect(await startCheckout("month", "en", { terms: false, immediatePerformance: true })).toEqual({
      ok: false,
      error: "consent_required",
    });
  });
});

describe("what the server records is what the page shows", () => {
  it("the page's wording version is one the function accepts", () => {
    expect(Object.keys(CONSENT_TEXTS)).toContain(CHECKOUT_CONSENT_VERSION);
    const read = readConsent({
      locale: "hr",
      consent: { terms: true, immediatePerformance: true, version: CHECKOUT_CONSENT_VERSION },
    });
    expect(read.ok && read.consent.kinds).toEqual([...CONSENT_KINDS]);
  });

  it("the server's hash of each language is the hash of these exact words (a change needs a new version)", () => {
    for (const [locale, dict] of [
      ["en", planEn],
      ["hr", planHr],
    ] as const) {
      const text = consentStatements(dict.billing.consent).join("\n");
      expect(sha256(text), `${locale}: bump CHECKOUT_CONSENT_VERSION and add it to CONSENT_TEXTS`).toBe(
        CONSENT_TEXTS[CHECKOUT_CONSENT_VERSION][locale],
      );
    }
    expect(consentStatements(planEn.billing.consent)[0]).toBe("I agree to the Terms of Use");
  });

  it("the terms the server names are the documents served at /terms", () => {
    for (const [locale, file] of [
      ["en", "TERMS.md"],
      ["hr", "TERMS.hr.md"],
    ] as const) {
      const text = readFileSync(new URL(file, docs), "utf8");
      expect(sha256(text), `${file} changed: update TERMS (version and hashes) in consent.ts`).toBe(TERMS.sha256[locale]);
      expect(LEGAL_TEXTS.terms[locale]).toBe(text);
    }
    expect(TERMS.version).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    // While the terms are a draft, the version says so.
    if (LEGAL_TEXTS.terms.en.includes("Draft - not yet in force")) {
      expect(TERMS.version.startsWith("draft-")).toBe(true);
    }
  });

  it("Stripe's reminder above Pay fits its limit, in both languages", () => {
    for (const message of Object.values(SUBMIT_MESSAGE)) {
      expect(message.length).toBeGreaterThan(20);
      expect(message.length).toBeLessThanOrEqual(1200);
    }
  });
});

describe("after paying, and the refusals", () => {
  it("the success page repeats the confirmation, in both languages", () => {
    const en = render("en", createElement(BillingSuccessView, { running: false, slow: false }));
    expect(en).toContain("As you asked, Pro starts now.");
    expect(en).toContain("acknowledged that you lose your right of withdrawal once Pro has started");
    expect(en).toContain("the receipt Stripe emails you repeats it");
    const hr = render("hr", createElement(BillingSuccessView, { running: true, slow: false }));
    expect(hr).toContain("Na tvoj zahtjev Pro počinje odmah.");
    expect(hr).toContain("pravo na jednostrani raskid ugovora");
  });

  it("the function's consent refusals are worded in both languages", () => {
    for (const dict of [planEn, planHr]) {
      expect(dict.billing.errors.consent_required.length).toBeGreaterThan(10);
      expect(dict.billing.errors.consent_outdated.length).toBeGreaterThan(10);
    }
  });
});
