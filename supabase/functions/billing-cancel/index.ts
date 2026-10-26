/**
 * Edge Function `billing-cancel` (docs/RAIL-PLAN.md R6.3, docs/BILLING.md). Everything
 * is in `handler.ts`; this file only serves it, so the tests can import the
 * handler without starting a server.
 */

import { billingEnvFromDeno } from "../_shared/billing/config.ts";
import { handle } from "./handler.ts";

Deno.serve((request) => handle(request, billingEnvFromDeno()));
