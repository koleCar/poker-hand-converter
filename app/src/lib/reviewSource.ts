/**
 * The session review in the app (R5.1 in the desktop app, R5.4): the shared
 * screen's `SessionReviewSource` over the local store (`session_review`,
 * `review_sessions`: the web's `session_review` and `report_sessions` rules
 * over `hand_list`), and the own charts' `SessionChartsSource`
 * (`session_preflop`, `review_hands`) for "off your own chart".
 *
 * The store's rows carry the stakes' blinds; the label is written here, as
 * the Hands screen writes it. The filter's groups are not applied (the
 * review reads every hand, bomb pots out, as the web's does with no filter).
 */
import type { SessionChartsSource } from "@rail/ui/charts/sessionSource";
import type { TableSize } from "@rail/ui/charts/model";
import { stakes } from "@rail/ui/hands/format";
import type { ReviewHand, SessionListItem, SessionReview, SessionReviewSource } from "@rail/ui/review/model";

import { ANALYSIS_VERSION } from "../analysis/library";
import { ipc } from "./ipc";

/** The picker reads the last this many days (the whole history when they hold fewer than two sessions). */
const PICKER_DAYS = 90;
const PICKER_MAX = 200;

/** A store row as the review's `ReviewHand`: the stakes label written from its blinds. */
export function reviewHand(row: Record<string, unknown>): ReviewHand {
  const hand = row as unknown as ReviewHand & { smallBlind?: number };
  const label =
    hand.bigBlind !== null && typeof hand.smallBlind === "number"
      ? stakes({
          currency: hand.currency,
          currencySymbol: hand.currencySymbol,
          minorUnits: hand.minorUnits,
          smallBlind: hand.smallBlind,
          bigBlind: hand.bigBlind,
        })
      : null;
  const out: ReviewHand & { smallBlind?: number } = { ...hand, stakesLabel: label };
  delete out.smallBlind;
  return out;
}

function hands(map: unknown): Record<string, ReviewHand> {
  const out: Record<string, ReviewHand> = {};
  for (const [key, row] of Object.entries((map ?? {}) as Record<string, Record<string, unknown>>)) out[key] = reviewHand(row);
  return out;
}

export const storeReviewSource: SessionReviewSource = {
  async review(query, limit): Promise<SessionReview> {
    const review = (await ipc.sessionReview(ANALYSIS_VERSION, query.at, query.gapMinutes, limit)) as unknown as SessionReview;
    return { ...review, hands: hands(review.hands) };
  },

  async sessions(query): Promise<SessionListItem[]> {
    const since = new Date(Date.now() - PICKER_DAYS * 86_400_000).toISOString();
    const recent = await ipc.reviewSessions(query.gapMinutes, since, PICKER_MAX);
    // The window's oldest may begin before it: left out, as the web leaves it.
    if (recent.length >= 2) return recent.slice(0, -1);
    return ipc.reviewSessions(query.gapMinutes, null, PICKER_MAX);
  },
};

export const storeSessionChartsSource: SessionChartsSource = {
  async sessionDecisions(session) {
    const rows = await ipc.sessionPreflop(ANALYSIS_VERSION, session.startedAt, session.endedAt);
    return rows.map((row) => ({
      handId: row.handId,
      ord: row.ord,
      actionIndex: row.actionIndex,
      playedAt: row.playedAt || null,
      key: row.key,
      cls: row.cls,
      action: row.action,
      scenario: row.scenario || null,
      position: row.position,
      gameFormat: row.gameFormat || null,
      tableSize: row.tableSize === 2 || row.tableSize === 6 || row.tableSize === 9 ? (row.tableSize as TableSize) : null,
      depthBandBb: row.depthBandBb,
      evLossBb: row.evLossBb,
    }));
  },

  async hands(handIds) {
    return hands(await ipc.reviewHands(ANALYSIS_VERSION, handIds.slice(0, 50)));
  },
};
