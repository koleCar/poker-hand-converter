/**
 * Our own standard format, read back in.
 *
 * Re-uploading a file this app produced has to work: users download the
 * converted output, import it into a tracker, and then drop the same file back
 * into the replayer. This parser closes that loop, and it is also what makes
 * the `parse(serialize(h)) === h` property testable.
 *
 * It intentionally scores low on formats that belong to a real room (PokerStars
 * and GG both use a `... Hand #` header) so that a dedicated parser for those
 * rooms always wins the detection race.
 */

import { type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  STANDARD_TEXT_PARSER_VERSION,
  parseStandardHand,
  splitStandardHands,
} from "../phf/serialize";
import type { PhfHand } from "../phf/types";

export const standardParser: SiteParser = {
  id: "standard",
  name: "PokerConverter standard",
  version: STANDARD_TEXT_PARSER_VERSION,

  detect(text: string): number {
    // Our own output, and the GG exports the format was modelled on.
    if (/^Poker Hand #/m.test(text)) {
      return 0.9;
    }
    // Other rooms share the shape; claim them only weakly so a dedicated
    // parser registered later outranks this one.
    if (/^(?:PokerStars|GG) Hand #/m.test(text)) {
      return 0.25;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    return splitStandardHands(text);
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const hand = parseStandardHand(raw, {
      siteId: "standard",
      siteName: "PokerConverter standard",
      originalFilename: ctx.sourceFilename,
      parserId: "standard",
      parserVersion: STANDARD_TEXT_PARSER_VERSION,
    });
    if (!hand) {
      throw new Error("Not a standard-format hand.");
    }
    return hand;
  },
};
