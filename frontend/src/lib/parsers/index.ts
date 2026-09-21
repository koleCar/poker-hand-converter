/**
 * Parser registry.
 *
 * ## Adding a site
 *
 * 1. Create `frontend/src/lib/parsers/<site>.ts` exporting a `SiteParser`
 *    (see `docs/PHF-SPEC.md`, "How to write a new site parser", for an
 *    annotated skeleton).
 * 2. Import it here and add one `registerParser` call.
 * 3. Add the site's sample file to `backend/test/fixtures/<site>/` and let the
 *    table-driven tests pick it up.
 *
 * Nothing else changes: detection, validation, failure recording, the standard
 * text serializer and the replayer all work off `PhfHand`.
 *
 * Importing this module is what populates the registry, so anything that calls
 * `convertAny` or `detectSite` must import from here (or from `lib/phf`) rather
 * than from `lib/phf/detect` directly.
 */

import { registerParser } from "../phf/detect";
import { acrwpnParser } from "./acrwpn";
import { chicoParser } from "./chico";
import { coinpokerParser } from "./coinpoker";
import { entractionParser } from "./entraction";
import { fulltiltParser } from "./fulltilt";
import { ggpokerParser } from "./ggpoker";
import { ignitionParser } from "./ignition";
import { ipokerParser } from "./ipoker";
import { microgamingParser } from "./microgaming";
import { ongameParser } from "./ongame";
import { partypokerParser } from "./partypoker";
import { pokerbrosParser } from "./pokerbros";
import { runitonceParser } from "./runitonce";
import { poker888Parser } from "./pokerstars888";
import { pokerstarsParser } from "./pokerstars";
import { standardParser } from "./standard";
import { unibetParser } from "./unibet";
import { weplayParser } from "./weplay";
import { winamaxParser } from "./winamax";

// Order does not matter; detection is by confidence, not registration order.
registerParser(weplayParser);
registerParser(standardParser);
registerParser(pokerstarsParser);
registerParser(ggpokerParser);
registerParser(poker888Parser);
registerParser(partypokerParser);
registerParser(ipokerParser);
registerParser(coinpokerParser);
registerParser(unibetParser);
registerParser(ongameParser);
registerParser(entractionParser);
registerParser(microgamingParser);
registerParser(fulltiltParser);
registerParser(runitonceParser);
registerParser(pokerbrosParser);
registerParser(ignitionParser);
registerParser(winamaxParser);
registerParser(chicoParser);
registerParser(acrwpnParser);

export {
  acrwpnParser,
  chicoParser,
  coinpokerParser,
  entractionParser,
  fulltiltParser,
  ggpokerParser,
  ignitionParser,
  ipokerParser,
  microgamingParser,
  ongameParser,
  partypokerParser,
  poker888Parser,
  pokerbrosParser,
  pokerstarsParser,
  runitonceParser,
  standardParser,
  unibetParser,
  weplayParser,
  winamaxParser,
};
export {
  convertAny,
  detectSite,
  fingerprint,
  fingerprintSync,
  getParser,
  getParsers,
  registerParser,
  unregisterParser,
  ParseSkip,
  DETECTION_THRESHOLD,
  type ConversionFailure,
  type ConversionResult,
  type ConvertOptions,
  type DetectionCandidate,
  type SiteParser,
  type SiteParserContext,
} from "../phf/detect";
