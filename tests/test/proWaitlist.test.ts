/**
 * The Pro waitlist (owner, 2026-11-19; `web/src/lib/billing/waitlist.ts`,
 * `components/plan/ProWaitlistDialog.tsx`, `20271119210000_pro_waitlist.sql`):
 *
 * - every "Upgrade to Pro" goes to "Pro is coming" while paid plans are not
 *   open, and to the checkout again by itself once `billing-checkout` says
 *   they are; a visitor (who cannot ask) gets the waitlist;
 * - the form's address check is the server's;
 * - the dialog in English and Croatian: one line, the email (the account's,
 *   editable; empty for a visitor), the one box, "Notify me"; then on the
 *   list / already on it.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NO_OFFER, parseBillingOffer } from "../../web/src/lib/billing/checkout.js";
import { looksLikeEmail, upgradeRoute } from "../../web/src/lib/billing/waitlist.js";
import { ProWaitlistDialog } from "../../web/src/components/plan/ProWaitlistDialog.js";
import { AuthContext, type AuthContextValue } from "../../web/src/lib/auth/context.js";
import { I18nProvider } from "../../web/src/lib/i18n/client.js";

const ON_SALE = parseBillingOffer({
  available: true,
  prices: { month: { amount: 2500, currency: "usd", interval: "month", taxInclusive: false }, half_year: null, year: null },
});

function auth(email: string | null): AuthContextValue {
  return {
    status: email ? "signed-in" : "signed-out",
    user: email ? ({ id: "00000000-0000-0000-0000-000000000001", email } as AuthContextValue["user"]) : null,
    isSignedIn: email !== null,
  } as AuthContextValue;
}

type State = "editing" | "done" | "already";

const dialog = (locale: "en" | "hr", email: string | null, state: State) =>
  renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale },
      createElement(
        AuthContext.Provider,
        { value: auth(email) },
        createElement(ProWaitlistDialog, { source: "pricing", onClose: () => {}, initialState: state }),
      ),
    ),
  );

describe("where Upgrade to Pro leads", () => {
  it("to the waitlist while paid plans are not open, for every reader", () => {
    expect(upgradeRoute(false, null)).toBe("waitlist");
    expect(upgradeRoute(false, ON_SALE)).toBe("waitlist");
    expect(upgradeRoute(true, NO_OFFER)).toBe("waitlist");
    expect(upgradeRoute(true, parseBillingOffer({ available: true, prices: {} }))).toBe("waitlist");
  });

  it("to the checkout again once Stripe answers, and waits while it has not", () => {
    expect(upgradeRoute(true, ON_SALE)).toBe("checkout");
    expect(upgradeRoute(true, null)).toBe("wait");
  });
});

describe("the address check", () => {
  it("is the server's", () => {
    expect(looksLikeEmail(" someone@example.com ")).toBe(true);
    expect(looksLikeEmail("a@b.co")).toBe(true);
    expect(looksLikeEmail("someone@example")).toBe(false);
    expect(looksLikeEmail("some one@example.com")).toBe(false);
    expect(looksLikeEmail("")).toBe(false);
    expect(looksLikeEmail(`${"x".repeat(250)}@example.com`)).toBe(false);
  });
});

describe("Pro is coming", () => {
  it("signed in: one line, the account's email to edit, the one box unticked, no prices", () => {
    const html = dialog("en", "member@example.com", "editing");
    expect(html).toContain("Pro is coming");
    expect(html).toContain("Rail Pro is still in development, so paid plans aren&#x27;t open yet.");
    expect(html).toMatch(/<input[^>]*type="email"[^>]*value="member@example.com"/);
    expect(html).toContain("Email me once when Pro opens. Nothing else.");
    expect(html).toMatch(/<input[^>]*type="checkbox"(?![^>]*checked=)[^>]*>/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain("Notify me");
    expect(html).not.toContain("$");
    expect(html).not.toContain("Continue to payment");
  });

  it("a visitor: the email empty", () => {
    const html = dialog("en", null, "editing");
    expect(html).toMatch(/<input[^>]*type="email"[^>]*value=""/);
  });

  it("on the list, and already on it", () => {
    const done = dialog("en", "member@example.com", "done");
    expect(done).toContain("You&#x27;re on the list");
    expect(done).toContain("We&#x27;ll write to member@example.com when Pro opens.");
    expect(done).not.toContain('type="email"');
    expect(dialog("en", "member@example.com", "already")).toContain("You&#x27;re already on the list");
  });

  it("speaks Croatian", () => {
    const html = dialog("hr", null, "editing");
    expect(html).toContain("Pro uskoro stiže");
    expect(html).toContain("Pošalji mi jedan e-mail kad se Pro otvori. Ništa drugo.");
    expect(html).toContain("Javi mi");
    expect(dialog("hr", "clan@example.com", "done")).toContain("Na popisu si");
    expect(dialog("hr", "clan@example.com", "already")).toContain("Već si na popisu");
  });
});
