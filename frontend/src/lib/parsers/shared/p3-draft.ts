/**
 * The one place parser agent 3's rooms reach into the PokerStars-family draft.
 *
 * Full Tilt, Run It Once and PokerBros are all PokerStars-family grammars, and
 * their *semantics* - how `raises X to Y` becomes chips added, how an uncalled
 * return nets out of a street commitment, how SUMMARY prose maps onto
 * `PhfPlayerResult`, how runouts are assembled - are exactly the semantics
 * `shared/ps-gg-hand.ts` already implements for PokerStars and GGPoker.
 * Re-implementing them per room is how three copies drift apart, so they are
 * reused rather than copied.
 *
 * `ps-gg-hand.ts` belongs to parser agent 1, though, so everything crosses that
 * boundary here and nowhere else: one file to fix if that module's surface
 * changes, instead of four. Nothing in this file writes to it.
 */

export {
  MONEY,
  StarsHandDraft,
  buyInUnitFor,
  detectDecimals,
  detectPadHour,
  hasUnsupportedCurrency,
  limitFromLabel,
  normalizeNewlines,
  stripBom,
  toLines,
  unitForStakes,
  variantFromLabel,
  type DraftGame,
} from "./ps-gg-hand";
