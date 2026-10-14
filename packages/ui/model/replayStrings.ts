/**
 * The replay captions' English (`frontend/src/lib/replayStrings.ts`), on its
 * own: what `strings/replayer.en.ts` takes as `frames`. A door of its own
 * rather than `model/replay`, so the dictionaries import just this small
 * module, as they did in the web before R2.7a moved them here, and not the
 * replay builder behind it. See `phf.ts` for why `model/` exists.
 */
export { ENGLISH_REPLAY_STRINGS, type ReplayStrings } from "../../../frontend/src/lib/replayStrings";
