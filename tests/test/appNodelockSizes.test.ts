/**
 * The nodelock editor's own sizes (`app/src/solver/nodelock/editor/sizes.ts`):
 * a size typed as % of the pot becomes the tree's label, an action can be
 * taken away and put back, the strategy carries over, a saved lock's labels
 * come back as actions, and the lock is `custom` only when the node's
 * actions changed (`lockSpec`).
 */
import { describe, expect, it } from "vitest";

import {
  actionsFromLabels,
  carryStrategy,
  isLibrary,
  passiveActions,
  sizeAction,
  sortActions,
  withActions,
} from "../../app/src/solver/nodelock/editor/sizes.js";
import { editorReducer, initialState } from "../../app/src/solver/nodelock/editor/state.js";
import { lockSpec, streetInOf, type LockAction, type LockTarget } from "../../app/src/solver/nodelock/spot.js";

const name = (kind: string, sizePot: number, amount: number) => `${kind} ${Math.round(sizePot * 100)} ${amount}`;

const act = (label: string, kind: LockAction["kind"], amount: number, sizePot: number, gto: number): LockAction => ({
  label,
  name: name(kind, sizePot, amount),
  kind,
  amount,
  sizePot,
  gto,
});

/** BB first to act on a 5.5 bb pot, 97.5 behind: Check, Bet 33 % (B1.82), Bet 75 % (B4.13). Three hands. */
function bbFirst(): LockTarget {
  const library = [act("X", "check", 0, 0, 0), act("B1.82", "bet", 1.82, 0.33, 1), act("B4.13", "bet", 4.13, 0.75, 2)];
  return {
    street: "flop",
    path: "",
    nodePath: "",
    player: 0,
    pot: 5.5,
    toCall: 0,
    behind: 97.5,
    streetIn: 0,
    actions: library,
    library,
    spot: {
      hands: [100, 200, 300],
      reach: [1, 1, 1],
      // Hand 0 always checks; hand 1 mixes; hand 2 only bets big.
      gto: [
        [1, 0.5, 0],
        [0, 0.25, 0],
        [0, 0.25, 1],
      ],
      ev: [
        [1, 2, 3],
        [0.5, 2, 4],
        [0.2, 1.8, 5],
      ],
    },
  } as unknown as LockTarget;
}

/** BTN facing a 1.82 bet into 5.5: Fold, Call, Raise to 7.28 (R7.28), all-in 97.5. */
function facingBet(): LockTarget {
  const library = [act("F", "fold", 0, 0, 0), act("C", "call", 1.82, 0, 1), act("R7.28", "raise", 7.28, 0.6, 2)];
  return {
    ...bbFirst(),
    path: "B1.82",
    nodePath: "B1.82",
    player: 1,
    pot: 7.32,
    toCall: 1.82,
    behind: 97.5,
    streetIn: 0,
    actions: library,
    library,
  } as unknown as LockTarget;
}

describe("sizeAction", () => {
  it("makes a bet of the typed % of the pot, labelled as the tree labels it", () => {
    const made = sizeAction(bbFirst(), 150, name);
    expect(made).toMatchObject({ label: "B8.25", kind: "bet", gto: null });
    expect((made as LockAction).amount).toBeCloseTo(8.25, 9);
  });

  it("gives the library's own action back for the library's size", () => {
    const target = withActions(bbFirst(), [bbFirst().library[0]]);
    expect(sizeAction(target, 75, name)).toMatchObject({ label: "B4.13", gto: 2 });
  });

  it("raises by % of the pot after the call, at least the minimum", () => {
    // 1.82 to call + 100 % of (7.32 + 1.82) = 10.96.
    expect(sizeAction(facingBet(), 100, name)).toMatchObject({ label: "R10.96", kind: "raise" });
    // 1 % would raise less than the bet faced: the minimum is to 3.64.
    expect(sizeAction(facingBet(), 1, name)).toMatchObject({ label: "R3.64" });
  });

  it("turns a size at the stack into all-in", () => {
    expect(sizeAction(bbFirst(), 5000, name)).toMatchObject({ label: "A97.5", kind: "allin" });
    expect(sizeAction(bbFirst(), null, name)).toMatchObject({ label: "A97.5", kind: "allin" });
  });

  it("says why a size cannot be added", () => {
    expect(sizeAction(bbFirst(), 0, name)).toBe("tooSmall");
    expect(sizeAction(bbFirst(), 33, name)).toBe("there");
    expect(sizeAction({ ...bbFirst(), behind: 0 } as LockTarget, 50, name)).toBe("noBet");
  });
});

describe("withActions", () => {
  it("is the library's decision for the library's actions", () => {
    const base = bbFirst();
    expect(withActions(base, base.library)).toBe(base);
    expect(isLibrary(withActions(base, [...base.library]))).toBe(true);
  });

  it("scales GTO over the actions left; a hand that only checked goes to its best action", () => {
    const base = bbFirst();
    const noCheck = withActions(base, base.library.slice(1));
    const gto = noCheck.spot.gto.map((row) => Array.from(row));
    // Hand 0 only checked: its best bet by EV is B1.82 (0.5 vs 0.2).
    expect(gto.map((row) => row[0])).toEqual([1, 0]);
    // Hand 1 bet 25/25: half each once the check is gone.
    expect(gto.map((row) => row[1])).toEqual([0.5, 0.5]);
    expect(isLibrary(noCheck)).toBe(false);
  });

  it("gives a new size no GTO share and EVs between the nearest library sizes", () => {
    const base = bbFirst();
    const half = sizeAction(base, 54, name) as LockAction;
    const target = withActions(base, sortActions([...base.library, half]));
    expect(target.actions.map((a) => a.label)).toEqual(["X", "B1.82", "B2.97", "B4.13"]);
    expect(Array.from(target.spot.gto[2])).toEqual([0, 0, 0]);
    // Halfway between 33 % and 75 %: hand 2's EV between 4 and 5.
    const ev = target.spot.ev[2][2];
    expect(ev).toBeGreaterThan(4);
    expect(ev).toBeLessThan(5);
  });
});

describe("the strategy across a change of actions", () => {
  it("keeps the rows that stay and hands a removed action's share to the rest", () => {
    const base = bbFirst();
    const state = { strategy: [[0.5, 1, 0], [0.5, 0, 0], [0, 0, 1]], locked: [1, 1, 0] };
    const to = withActions(base, base.library.slice(1));
    const carried = carryStrategy(base, state, to);
    // Hand 0 (locked) checked half: all of it bets 33 % now. Hand 1 (locked) only checked: its best bet.
    expect(carried.strategy.map((row) => row[0])).toEqual([1, 0]);
    expect(carried.strategy.map((row) => row[1])).toEqual([1, 0]);
    // Hand 2 is unlocked: the new GTO.
    expect(carried.strategy.map((row) => row[2])).toEqual([0, 1]);
  });

  it("is one undo step in the editor", () => {
    const base = bbFirst();
    const reduce = (s: ReturnType<typeof initialState>, a: Parameters<typeof editorReducer>[2]) =>
      editorReducer(withActions(base, s.actions ?? base.library).spot, s, a);
    const start = initialState(base.spot);
    const to = withActions(base, base.library.slice(1));
    const changed = reduce(start, { type: "actions", actions: to.actions, ...carryStrategy(base, start, to) });
    expect(changed.actions?.map((a) => a.label)).toEqual(["B1.82", "B4.13"]);
    expect(changed.strategy).toHaveLength(2);
    const locked = reduce(changed, { type: "lockAll" });
    expect(locked.actions).toBe(changed.actions);
    const back = reduce(reduce(locked, { type: "undo" }), { type: "undo" });
    expect(back.actions).toBeUndefined();
    expect(back.strategy).toHaveLength(3);
  });
});

describe("the lock", () => {
  it("is custom only when the actions changed", () => {
    const base = bbFirst();
    const start = initialState(base.spot);
    expect(lockSpec(base, start).custom).toBeUndefined();
    expect(lockSpec(base, start, true).custom).toBe(true);
    const to = withActions(base, base.library.slice(1));
    const spec = lockSpec(to, carryStrategy(base, start, to));
    expect(spec).toMatchObject({ actions: ["B1.82", "B4.13"], custom: true });
    expect(spec.strategy).toHaveLength(2);
  });

  it("comes back from its labels", () => {
    const base = bbFirst();
    const back = actionsFromLabels(base, ["B1.82", "B8.25", "A97.5"], name);
    expect(back?.map((a) => [a.label, a.kind, a.gto])).toEqual([
      ["B1.82", "bet", 1],
      ["B8.25", "bet", null],
      ["A97.5", "allin", null],
    ]);
    expect(back?.[1].sizePot).toBeCloseTo(1.5, 9);
    expect(actionsFromLabels(base, ["C"], name)).toBeNull();
    expect(actionsFromLabels(facingBet(), ["C", "R12"], name)?.map((a) => a.kind)).toEqual(["call", "raise"]);
  });

  it("puts the library's check, fold or call back", () => {
    const base = facingBet();
    expect(passiveActions(withActions(base, base.library.slice(1))).map((a) => a.label)).toEqual(["F"]);
    expect(passiveActions(base)).toEqual([]);
  });
});

describe("streetInOf", () => {
  it("reads what the actor put in on the street from the path", () => {
    expect(streetInOf("")).toBe(0);
    expect(streetInOf("X")).toBe(0);
    expect(streetInOf("B1.82")).toBe(0);
    expect(streetInOf("B1.82-R7.28")).toBe(1.82);
    expect(streetInOf("X-B2.5-R9")).toBe(2.5);
    expect(streetInOf("X-X|Kd|X-B4")).toBe(0);
    expect(streetInOf("X-X|Kd|B4-R12")).toBe(4);
  });
});
