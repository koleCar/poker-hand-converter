/**
 * Edge Function `feedback`: bug reports, feature requests and questions from
 * the web and the desktop app. Everything is in `handler.ts`; this file only
 * serves it, so the tests can import the handler without starting a server.
 */

import { envFromDeno, handle } from "./handler.ts";

Deno.serve((request) => handle(request, envFromDeno()));
