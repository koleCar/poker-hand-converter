import { useEffect, useState } from "react";

/**
 * `.rail-stagger` for a virtualised list (the Hands and Players grids): the
 * rows in view arrive one after another when a new list lands, and only then.
 *
 *   - `listKey` names the list shown (its filter). A new key (and the first
 *     render) bumps `enterKey`, which the caller puts as the `key` of the rows'
 *     container so every row in view plays again, and turns the class on.
 *   - The class goes off at the first scroll (`stop`) and after the stagger has
 *     played, so rows mounted by scrolling or a resize simply appear instead of
 *     waiting their turn - a virtualised list stays cheap.
 *
 * A reload of the same list (hands arrived) keeps the key: nothing replays.
 */
const PLAYED_MS = 900;

export function useListEnter(listKey: unknown): { enterKey: number; staggerClass: string; stop: () => void } {
  const [state, setState] = useState({ key: listKey, enterKey: 0, on: true });
  if (state.key !== listKey) {
    setState({ key: listKey, enterKey: state.enterKey + 1, on: true });
  }

  const { on, enterKey } = state;
  useEffect(() => {
    if (!on) return;
    const timer = window.setTimeout(() => setState((was) => (was.enterKey === enterKey ? { ...was, on: false } : was)), PLAYED_MS);
    return () => window.clearTimeout(timer);
  }, [on, enterKey]);

  const stop = () => {
    if (on) setState((was) => ({ ...was, on: false }));
  };

  return { enterKey, staggerClass: on ? "rail-stagger" : "", stop };
}
