/**
 * Edge Function `account-delete` (docs/RAIL-PLAN.md R6.5): deletes the
 * account whose JWT calls it. Everything is in `handler.ts` (the steps) and
 * `billing.ts` (the subscription); this file only serves it, so the tests
 * can import the handler without starting a server.
 */

import { envFromDeno, handle } from "./handler.ts";

Deno.serve((request) => handle(request, envFromDeno()));
