/**
 * The Solver tab's route parameter: the view as a query string
 * (`set=…&line=…&flop=…&node=…&turn=…`), checked as the web's `/solver`
 * checks its address bar - anything malformed is the start of each.
 *
 * A link from a hand (`spotParam`, the replayer's "Open in Solver") adds
 * where the hand stands, read once when the tab opens: a flop decision's
 * `path` in its solve, or the hand's `walk` to a turn or river decision
 * (`solverWalk.ts`), and the hero's cards and seat (`hero=Qs9s&pos=BTN`),
 * marked in the grid.
 */
import type { SolverView, StrategyHero } from "./door";
import type { SolverSpot } from "./spot";

const SET_RE = /^nlhe-cash-(hu|\d{1,2}max)-\d{1,3}bb(-ante|-straddle)?$/;
const LINE_RE = /^[fkcra]{1,24}$/;
const FLOP_RE = /^([2-9TJQKA][cdhs]){3}$/;
const NODE_RE = /^\d{1,5}$/;
const TURN_RE = /^[A-Za-z0-9._-]{1,60}~[2-9TJQKA][cdhs]$/;
/** A flop decision's path in its solve (`X-B1.82-C`). */
const PATH_RE = /^[A-Za-z0-9.~_-]{1,200}$/;
/** The web's `/solver` `?walk=`: actions and cards joined by `-`. */
const WALK_RE = /^(?:[fxc]|[br]\d{1,4}a?|[2-9TJQKA][cdhs])(?:-(?:[fxc]|[br]\d{1,4}a?|[2-9TJQKA][cdhs])){0,39}$/;
const HERO_RE = /^([2-9TJQKA][cdhs]){2}$/;
const POSITION_RE = /^[A-Z+0-9]{2,5}$/;

export interface SolverStart {
  set: string | null;
  line: string | null;
  flop: string | null;
  node: number | null;
  turn: string | null;
}

/** The route as read: the view, and where a hand's link asked to land. */
export interface SolverRoute extends SolverStart {
  path: string | null;
  walk: string | null;
  hero: StrategyHero | null;
  /** The link stands in for the hand's spot (`handSpot.ts`): what it shows instead. */
  approx: "flop" | "preflop" | null;
  /** The hand's own stack depth in bb, when the set's is not it. */
  handDepth: number | null;
}

export function parseSolverParam(param: string | null): SolverRoute {
  const query = new URLSearchParams(param ?? "");
  const valid = (key: string, re: RegExp) => {
    const value = query.get(key);
    return value && re.test(value) ? value : null;
  };
  const node = valid("node", NODE_RE);
  const cards = valid("hero", HERO_RE);
  const position = valid("pos", POSITION_RE);
  return {
    set: valid("set", SET_RE),
    line: valid("line", LINE_RE),
    flop: valid("flop", FLOP_RE),
    node: node ? Number(node) : null,
    turn: valid("turn", TURN_RE),
    path: valid("path", PATH_RE),
    walk: valid("walk", WALK_RE),
    hero: cards && position ? { cards, position } : null,
    approx: valid("approx", /^(flop|preflop)$/) as SolverRoute["approx"],
    handDepth: (() => {
      const eff = valid("eff", /^\d{1,4}$/);
      return eff ? Number(eff) : null;
    })(),
  };
}

/** A hand's spot as the tab's parameter (`solver/spot.ts`), with the hero's cards when known. */
export function spotParam(spot: SolverStart & Pick<SolverSpot, "path" | "walk">, hero: StrategyHero | null): string {
  const query = new URLSearchParams();
  if (spot.set) query.set("set", spot.set);
  if (spot.line) query.set("line", spot.line);
  if (spot.flop) query.set("flop", spot.flop);
  if (spot.node) query.set("node", String(spot.node));
  if (spot.turn) query.set("turn", spot.turn);
  if (spot.walk) query.set("walk", spot.walk);
  else if (spot.path) query.set("path", spot.path);
  if (hero) {
    query.set("hero", hero.cards);
    query.set("pos", hero.position);
  }
  return query.toString();
}

export function solverParam(view: SolverView): string {
  const query = new URLSearchParams({ set: view.set });
  if (view.line) query.set("line", view.line);
  if (view.flop) query.set("flop", view.flop);
  if (view.node) query.set("node", String(view.node));
  if (view.turn) query.set("turn", view.turn);
  return query.toString();
}
