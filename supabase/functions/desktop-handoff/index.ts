/**
 * Edge Function `desktop-handoff` (docs/RAIL-PLAN.md R1.7): the desktop
 * app's sign-in handoff. Everything is in `handler.ts` (the HTTP side) and
 * `handoff.ts` (the payload); this file only serves it, so the tests can
 * import the handler without starting a server.
 */

import { envFromDeno, handle } from "./handler.ts";

Deno.serve((request) => handle(request, envFromDeno()));
