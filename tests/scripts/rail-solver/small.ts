/**
 * The reduced flop spot of the native solver's fixtures (`fixtures.test.ts`)
 * and of the tests that read them (`tests/test/appNodelockNative.test.ts`):
 * BTN vs BB on Ks5h3s with the flop library's bet menus, small ranges.
 */
import { FLOP_PROFILE } from "../../../web/src/lib/analysis/flopLibrary.js";
import { parseRange } from "../../../web/src/lib/solver/combos.js";
import type { FlopSpot } from "../../../web/src/lib/solver/flop.js";

export const SMALL_R0 = "99-55, A5s-A2s, KTs+, QJs, T9s, 87s, 76s, KQo";
export const SMALL_R1 = "TT+, AQs+, AKo, K9s, 65s, 54s";

export function smallFlopSpot(): FlopSpot {
  const [r0, r1] = [SMALL_R0, SMALL_R1];
  const p = FLOP_PROFILE;
  return {
    board: ["Ks", "5h", "3s"],
    ranges: [parseRange(r0), parseRange(r1)],
    pot: 5.5,
    stack: 97.5,
    firstToAct: 0,
    menus: [p.flopMenu, p.flopMenu],
    raiseCap: p.flopRaiseCap,
    turnMenus: [p.turnMenu, p.turnMenu],
    turnRaiseCap: p.turnRaiseCap,
    riverMenus: [p.riverMenu, p.riverMenu],
    riverRaiseCap: p.riverRaiseCap,
    allInThreshold: p.allInThreshold,
    minBet: p.minBet,
    rake: { percent: 0.05, cap: 3 },
    bigBlind: 1,
    isomorphism: true,
  };
}
