/**
 * The Analytics catalogue oracle (docs/ANALYTICS.md Step 1): for every hand
 * of every golden, what the web's port of the decision events
 * (`web/src/lib/stats/events.ts`) and the catalogue (`analytics.ts`)
 * conclude.
 *
 * `testdata/golden-analytics/<input>.json` - committed, one entry per hand:
 *
 * - `events`: the sha-256 of the canonical JSON of `handEvents(hand)` - every
 *   field of every decision of every seat, so the port is held equal field
 *   for field without writing ~50 MB out;
 * - `counts`: per seat, every catalogue rate that is not 0/0 -
 *   `seat:id=made/opp,...`, seats apart by a space;
 * - `members`: every decision that belongs to a rate -
 *   `order@seat:id+,id-,...` (`+` taken), decisions apart by a space.
 *
 * One string each, so the committed tree stays a few MB.
 *
 * `core/rail-stats/tests/analytics_corpus.rs` builds the same from the Rust
 * events (`events.rs`) and the Rust catalogue (`analytics.rs`) over the same
 * hands (`testdata/golden-full/`) and compares.
 */

import { createHash } from "node:crypto";

import { ANALYTICS } from "../../../web/src/lib/stats/analytics.js";
import { handEvents } from "../../../web/src/lib/stats/events.js";
import { canonicalJson } from "./canonical.js";
import type { GoldenHandInput } from "./stats.js";

/** Bumped whenever the shape of an analytics golden changes. */
export const ANALYTICS_GOLDEN_FORMAT = "rail-analytics-golden/1";

export function analyticsGoldenFor(input: string, hands: GoldenHandInput[]): Record<string, unknown> {
  const out: Record<string, unknown>[] = [];
  for (const hand of hands) {
    const events = handEvents(JSON.parse(hand.phfText));
    const counts = events.seats
      .map((seat) => {
        const mine = ANALYTICS.counts(events, seat)
          .map((count, index) =>
            count.made !== 0 || count.opp !== 0 ? `${ANALYTICS.stats[index].id}=${count.made}/${count.opp}` : "",
          )
          .filter((text) => text !== "");
        return mine.length > 0 ? `${seat.seat}:${mine.join(",")}` : "";
      })
      .filter((text) => text !== "")
      .join(" ");
    const members = ANALYTICS.membership(events)
      .map(
        (member) =>
          `${member.order}@${member.seat}:` +
          member.stats.map(([index, taken]) => `${ANALYTICS.stats[index].id}${taken ? "+" : "-"}`).join(","),
      )
      .join(" ");
    out.push({
      index: hand.index,
      handId: hand.handId,
      events: createHash("sha256").update(canonicalJson(events)).digest("hex"),
      counts,
      members,
    });
  }
  return { format: ANALYTICS_GOLDEN_FORMAT, input, hands: out };
}
