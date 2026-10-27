/**
 * Heads-up flop games: flop betting, a dealt turn, turn betting, a dealt
 * river, river betting (phase A5b, the offline flop library).
 *
 * The same pieces as the turn game (`subgame.ts`): `buildStreet` for each
 * street's betting from a menu, a chance node per deal, a showdown ordering
 * per final board. A flop game is ~49x a turn game, so three things make it
 * affordable offline (it is not affordable in a browser, `docs/ANALYSIS-PLAN.md`
 * §10 A5a):
 *
 * - **Suit isomorphism on both deals.** Where the flop and both ranges are
 *   symmetric under a relabelling of suits (`spotSymmetries`), one turn card
 *   per orbit is dealt and the others are read back through the relabelling
 *   of the hands - the turn game's trick, one street up. Below each dealt
 *   turn card the river is dealt the same way, but only under the
 *   relabellings that keep that turn card where it is (its stabiliser):
 *   below `7h` on `Ks 8s 2d`, hearts and clubs are no longer interchangeable.
 *   The engine reads those per-edge mirrors (`Game.edgeMirrors`). Exact: the
 *   isomorphic game is the same game (tested against the full one). It saves
 *   nothing on a rainbow flop (no suit is free), about a quarter of the turn
 *   cards on a two-tone flop and two thirds on a monotone one.
 * - **A coarse tree below the flop**: the A5a turn menu and its river
 *   (`lib/analysis/flopLibrary.ts` has the profile the library solves).
 * - **16-bit storage** (`SolverConfig.storage = "i16"`): a third of the
 *   float32 memory.
 *
 * Chance sampling does not help here, for the reason it did not help the
 * turn (A5a): every turn and river subgame needs its own few dozen updates
 * whatever order they come in.
 *
 * The result of a flop solve is its flop-level nodes only (`nodes: "flop"`):
 * what the library stores. The turn and river below are solved to make the
 * flop strategy right, and then dropped.
 */

import { cardCode } from "../equity";
import { buildStreet, dealtPath, type BetMenu, type NodeInfo } from "./betting";
import { Solver, type RunResult } from "./cfr";
import { NUM_COMBOS, parseCards, SolverInputError, toRange } from "./combos";
import { handSet, showdownBoard, type Game, type Mirror, type ShowdownBoard } from "./game";
import { cardOrbit, permuteCard, permuteCombo, spotSymmetries, symmetrize } from "./isomorphism";
import { extract, type SolveOptions, type SolveResult } from "./solve";
import { handsOf, rulesOf, strengths, type BuiltSubgame, type FlopIsomorphism, type SpotInput } from "./subgame";
import { TreeBuilder } from "./tree";

export interface FlopSpot extends SpotInput {
  /** Turn menus; default `menus`. */
  turnMenus?: readonly [BetMenu, BetMenu];
  /** River menus; default the turn's. */
  riverMenus?: readonly [BetMenu, BetMenu];
  /** Raises per turn after the first bet; default `raiseCap`. */
  turnRaiseCap?: number;
  /** Raises per river after the first bet; default the turn's. */
  riverRaiseCap?: number;
  /** Deal one turn card per suit class, and one river card per class of its stabiliser (exact). */
  isomorphism?: boolean;
  /**
   * Keep the betting info of turn and river nodes in `BuiltSubgame.info`
   * (tests that walk the whole tree by path). Off by default: only the
   * flop's nodes are described, which is all a flop-level result reads.
   */
  deepInfo?: boolean;
}

const key = (perm: readonly number[]) => perm.join("");

/** Builds the flop game for a spot: flop betting, the turn, turn betting, the river, river betting. */
export function buildFlopGame(spot: FlopSpot): BuiltSubgame {
  const board = parseCards(spot.board);
  if (board.length !== 3) {
    throw new SolverInputError(`expected a 3-card board, got ${board.length}`);
  }
  if (!(spot.pot > 0) || !(spot.stack >= 0)) {
    throw new SolverInputError("pot must be positive and stack non-negative");
  }
  const flopRules = rulesOf(spot, spot.menus);
  const turnMenus = spot.turnMenus ?? spot.menus;
  const turnCap = spot.turnRaiseCap ?? spot.raiseCap;
  const turnRules = rulesOf(spot, turnMenus, turnCap);
  const riverRules = rulesOf(spot, spot.riverMenus ?? turnMenus, spot.riverRaiseCap ?? turnCap);

  let r0 = toRange(spot.ranges[0]);
  let r1 = toRange(spot.ranges[1]);
  const group = spot.isomorphism ? spotSymmetries(board, [r0, r1]) : [[0, 1, 2, 3]];
  if (group.length > 1) {
    r0 = symmetrize(r0, group);
    r1 = symmetrize(r1, group);
  }
  const h0 = handsOf(r0, board);
  const h1 = handsOf(r1, board);

  // Hand relabelling per permutation of the group: map[p][i] = index of perm(hand i).
  const lookup = [h0.combos, h1.combos].map((combos) => {
    const at = new Int32Array(NUM_COMBOS).fill(-1);
    combos.forEach((combo, i) => {
      at[combo] = i;
    });
    return at;
  });
  const handMaps = new Map<string, [Int32Array, Int32Array]>();
  const mapOf = (perm: readonly number[]): [Int32Array, Int32Array] => {
    let maps = handMaps.get(key(perm));
    if (!maps) {
      maps = [h0.combos, h1.combos].map((combos, p) =>
        Int32Array.from(combos, (combo) => {
          const index = lookup[p][permuteCombo(combo, perm)];
          if (index < 0) {
            throw new Error("isomorphism: a range is not symmetric after symmetrising");
          }
          return index;
        }),
      ) as [Int32Array, Int32Array];
      handMaps.set(key(perm), maps);
    }
    return maps;
  };

  /** One card per orbit of `group` among `cards`: the lowest deals, the rest mirror it. */
  const classesOf = (dead: readonly number[], sub: readonly (readonly number[])[]) => {
    const out: { card: number; mirrors: Mirror[] }[] = [];
    const seen = new Set<number>();
    for (let card = 0; card < 52; card += 1) {
      if (dead.includes(card) || seen.has(card)) {
        continue;
      }
      const orbit = cardOrbit(card, sub);
      for (const member of orbit) {
        seen.add(member);
      }
      const mirrors: Mirror[] = [];
      for (const other of orbit) {
        if (other === card) {
          continue;
        }
        const perm = sub.find((p) => permuteCard(other, p) === card) as number[];
        mirrors.push({ card: other, map: mapOf(perm) });
      }
      out.push({ card, mirrors });
    }
    return out;
  };

  const turns = classesOf(board, group);
  const riversOf = new Map<number, { card: number; mirrors: Mirror[] }[]>();
  for (const { card: turn } of turns) {
    const stabiliser = group.filter((perm) => permuteCard(turn, perm) === turn);
    riversOf.set(turn, classesOf([...board, turn], stabiliser));
  }

  // Showdown boards, one per (turn, river) pair dealt.
  const boardIds = new Map<number, number>();
  const boards: ShowdownBoard[] = [];
  const boardOf = (turn: number, river: number): number => {
    const k = turn * 64 + river;
    let id = boardIds.get(k);
    if (id === undefined) {
      id = boards.length;
      const five = [...board, turn, river];
      boards.push(showdownBoard(strengths(h0.cards, five), strengths(h1.cards, five)));
      boardIds.set(k, id);
    }
    return id;
  };

  const builder = new TreeBuilder();
  const info: (NodeInfo | undefined)[] = [];
  // Turn and river node info is a few hundred bytes of objects per node, a
  // million nodes deep, and a flop-level result never reads it: unless asked
  // for, it goes to a scratch array that is dropped with each street.
  const deepInfo = () => (spot.deepInfo ? info : []);
  const chancePath = new Map<number, string>();
  const pendingMirrors: { node: number; mirrors: (Mirror[] | undefined)[] }[] = [];
  const firstToAct = spot.firstToAct ?? 0;
  const turnWeight = 1 / (52 - 3 - 4);
  const riverWeight = 1 / (52 - 4 - 4);

  const riverDeal = (turn: number, c0: number, c1: number, allIn: boolean, path: string): number => {
    const classes = riversOf.get(turn) as { card: number; mirrors: Mirror[] }[];
    const edges = classes.map(({ card }) => ({
      label: cardCode(card),
      card,
      child: allIn
        ? builder.showdown(boardOf(turn, card), spot.pot, c0, c1, spot.rake)
        : buildStreet(
            {
              builder,
              street: "river",
              pot: spot.pot,
              stack: spot.stack,
              rake: spot.rake,
              first: firstToAct,
              rules: riverRules,
              info: deepInfo(),
              close: (a0, a1) => builder.showdown(boardOf(turn, card), spot.pot, a0, a1, spot.rake),
            },
            [c0, c1],
            dealtPath(path, card),
          ),
    }));
    const id = builder.chance(riverWeight, edges);
    chancePath.set(id, path);
    pendingMirrors.push({ node: id, mirrors: classes.map(({ mirrors }) => (mirrors.length ? mirrors : undefined)) });
    return id;
  };

  const turnDeal = (c0: number, c1: number, allIn: boolean, path: string): number => {
    const edges = turns.map(({ card }) => ({
      label: cardCode(card),
      card,
      child: allIn
        ? riverDeal(card, c0, c1, true, dealtPath(path, card))
        : buildStreet(
            {
              builder,
              street: "turn",
              pot: spot.pot,
              stack: spot.stack,
              rake: spot.rake,
              first: firstToAct,
              rules: turnRules,
              info: deepInfo(),
              close: (a0, a1, allIn2, path2) => riverDeal(card, a0, a1, allIn2, path2),
            },
            [c0, c1],
            dealtPath(path, card),
          ),
    }));
    const id = builder.chance(turnWeight, edges);
    chancePath.set(id, path);
    pendingMirrors.push({ node: id, mirrors: turns.map(({ mirrors }) => (mirrors.length ? mirrors : undefined)) });
    return id;
  };

  const root = buildStreet(
    {
      builder,
      street: "flop",
      pot: spot.pot,
      stack: spot.stack,
      rake: spot.rake,
      first: firstToAct,
      rules: flopRules,
      info,
      close: (c0, c1, allIn, path) => turnDeal(c0, c1, allIn, path),
    },
    [0, 0],
    "",
  );
  const tree = builder.finish(root);

  let edgeMirrors: (Mirror[] | undefined)[] | undefined;
  if (group.length > 1) {
    edgeMirrors = new Array(tree.children.length).fill(undefined);
    for (const { node, mirrors } of pendingMirrors) {
      const start = tree.childStart[node];
      mirrors.forEach((m, e) => {
        (edgeMirrors as (Mirror[] | undefined)[])[start + e] = m;
      });
    }
  }
  const game: Game = {
    tree,
    numCards: 52,
    hands: [handSet(0, 52, h0.cards, h0.weights), handSet(1, 52, h1.cards, h1.weights)],
    boards,
    pot: spot.pot,
    bigBlind: spot.bigBlind,
    edgeMirrors,
  };
  const flopIsomorphism: FlopIsomorphism | undefined =
    group.length > 1
      ? {
          group: group.map((perm) => perm.slice()),
          turns: turns.map(({ card, mirrors }) => ({
            card: cardCode(card),
            mirrors: mirrors.map((m) => cardCode(m.card)),
            rivers: (riversOf.get(card) as unknown[]).length,
          })),
          boards: boards.length,
        }
      : undefined;
  return {
    street: "flop",
    game,
    board,
    combos: [h0.combos, h1.combos],
    info,
    chancePath,
    pot: spot.pot,
    stack: spot.stack,
    firstToAct,
    flopIsomorphism,
  };
}

/** Progress of a flop solve, after every iteration. */
export interface FlopProgress {
  iteration: number;
  /** Milliseconds since the solve started (building the game included). */
  elapsedMs: number;
  /** Exploitability at the last measurement, % of the pot; NaN before the first. */
  exploitabilityPct: number;
}

export interface FlopSolveOptions extends Omit<SolveOptions, "nodes" | "onIteration"> {
  /** Called after every iteration; returning `false` cancels (the result then says `cancelled`). */
  onIteration?: (progress: FlopProgress) => boolean | void;
  /** Milliseconds clock for progress; default `Date.now`. Never read by the solve itself. */
  now?: () => number;
}

export interface FlopSolve {
  result: SolveResult;
  /** Action nodes and showdown boards of the whole game, and the solver's bytes. */
  stats: { nodes: number; actionNodes: number; boards: number; solverBytes: number; turnClasses: number };
  run: RunResult;
}

/**
 * Solves a flop spot through the river and returns its flop-level nodes.
 * Deterministic: the same spot and options give the same bits (the clock is
 * read for progress only). 16-bit storage unless `storage` says otherwise.
 */
export function solveFlop(spot: FlopSpot, options: FlopSolveOptions = {}): FlopSolve {
  const now = options.now ?? Date.now;
  const started = now();
  const built = buildFlopGame(spot);
  const solver = new Solver(built.game, options.dcfr, { sampling: options.sampling, storage: options.storage ?? "i16" });
  let lastPct = NaN;
  const run = solver.run({
    ...options,
    onProgress: (progress) => {
      lastPct = progress.exploitability.percentPot;
      return options.onProgress?.(progress);
    },
    onIteration: options.onIteration
      ? (iteration) => (options.onIteration as NonNullable<FlopSolveOptions["onIteration"]>)({ iteration, elapsedMs: now() - started, exploitabilityPct: lastPct })
      : undefined,
  });
  const tree = built.game.tree;
  let actionNodes = 0;
  for (let node = 0; node < tree.size; node += 1) {
    if (tree.type[node] === 0) actionNodes += 1;
  }
  const result = extract(built, solver, run, "flop");
  return {
    result,
    run,
    stats: {
      nodes: tree.size,
      actionNodes,
      boards: built.game.boards.length,
      solverBytes: solver.bytes,
      turnClasses: built.flopIsomorphism?.turns.length ?? 49,
    },
  };
}
