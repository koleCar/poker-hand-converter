/**
 * The Solver tab's route parameter: the view as a query string
 * (`set=…&line=…&flop=…&node=…&turn=…`), checked as the web's `/solver`
 * checks its address bar - anything malformed is the start of each.
 */
import type { SolverView } from "./door";

const SET_RE = /^nlhe-cash-(hu|\d{1,2}max)-\d{1,3}bb(-ante|-straddle)?$/;
const LINE_RE = /^[fkcra]{1,24}$/;
const FLOP_RE = /^([2-9TJQKA][cdhs]){3}$/;
const NODE_RE = /^\d{1,5}$/;
const TURN_RE = /^[A-Za-z0-9._-]{1,60}~[2-9TJQKA][cdhs]$/;

export interface SolverStart {
  set: string | null;
  line: string | null;
  flop: string | null;
  node: number | null;
  turn: string | null;
}

export function parseSolverParam(param: string | null): SolverStart {
  const query = new URLSearchParams(param ?? "");
  const valid = (key: string, re: RegExp) => {
    const value = query.get(key);
    return value && re.test(value) ? value : null;
  };
  const node = valid("node", NODE_RE);
  return {
    set: valid("set", SET_RE),
    line: valid("line", LINE_RE),
    flop: valid("flop", FLOP_RE),
    node: node ? Number(node) : null,
    turn: valid("turn", TURN_RE),
  };
}

export function solverParam(view: SolverView): string {
  const query = new URLSearchParams({ set: view.set });
  if (view.line) query.set("line", view.line);
  if (view.flop) query.set("flop", view.flop);
  if (view.node) query.set("node", String(view.node));
  if (view.turn) query.set("turn", view.turn);
  return query.toString();
}
