import type { Metadata } from "next";
import { BillingReturnScreen } from "../../../components/plan/BillingReturn";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * `/billing/cancel`: where Stripe Checkout returns when the buyer goes back
 * (R6.3, `BILLING_CANCEL_URL`). Nothing was charged. Not indexed.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.plan.billing.cancel.metaTitle,
    alternates: { canonical: paths.billingCancel() },
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default function BillingCancelPage() {
  return <BillingReturnScreen kind="cancel" />;
}
