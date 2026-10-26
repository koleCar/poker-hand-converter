/**
 * Writes `sdk_vector.json`: a webhook signature made by Stripe's **official**
 * SDK, which `stripe_test.ts` holds our own check to (docs/RAIL-PLAN.md R6.3).
 * Not run by CI (it downloads the SDK from npm); run it by hand to refresh:
 *
 *   deno run --allow-env --allow-read --allow-net=registry.npmjs.org \
 *     supabase/functions/_shared/billing/testdata/make_sdk_vector.ts \
 *     > supabase/functions/_shared/billing/testdata/sdk_vector.json
 *
 * The secret is made up for this vector; it is no endpoint's secret.
 */
import Stripe from "npm:stripe@17.7.0";

const stripe = new Stripe("sk_test_" + "x".repeat(24));
const secret = "whsec_rail_sdk_vector_not_a_real_secret_0001";
const payload = JSON.stringify({
  id: "evt_sdk_vector_1",
  object: "event",
  type: "customer.subscription.updated",
  created: 1790000000,
  livemode: false,
  data: { object: { id: "sub_sdkvector", object: "subscription", customer: "cus_sdkvector", note: "žćš ünïcode" } },
});
const timestamp = 1790000100;
const header = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret, timestamp });
// The SDK accepts its own header (tolerance wide enough for a fixed timestamp).
const event = await stripe.webhooks.constructEventAsync(payload, header, secret, 1e10);
console.log(
  JSON.stringify({ sdk: "stripe@17.7.0", secret, timestamp, payload, header, acceptedBySdk: event.id }, null, 2),
);
