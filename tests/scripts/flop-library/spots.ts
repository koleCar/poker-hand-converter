/**
 * A preflop line of the flop library as a solvable spot. The code lives in
 * the web's library (`web/src/lib/analysis/flopJob.ts`) since the desktop
 * app's nodelock re-solves library spots with it (docs/NODELOCK.md §2.3).
 */

export { lineSpot, type LineSpot } from "../../../web/src/lib/analysis/flopJob.js";
