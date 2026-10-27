import type { Metadata } from "next";
import { BillingReturnScreen } from "../../../components/plan/BillingReturn";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * `/billing/success`: where Stripe Checkout returns after paying (R6.3,
 * `BILLING_SUCCESS_URL`). It grants nothing itself - the webhook does - and
 * waits for the plan to show it. One account's own state: not indexed.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.plan.billing.success.metaTitle,
    alternates: { canonical: paths.billingSuccess() },
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default function BillingSuccessPage() {
  return <BillingReturnScreen kind="success" />;
}
