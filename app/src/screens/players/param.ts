/**
 * The Players screen's route parameter (`#/players/<site>:<name>`): an
 * opponent is their room's site key and their name. A site key never holds
 * a colon (`hand_key`'s prefix), a name may: the first colon splits them.
 */
import type { PlayerRef } from "../../lib/ipc";

export function playerParam(site: string, player: string): string {
  return `${site}:${player}`;
}

export function parsePlayerParam(param: string | null): PlayerRef | null {
  if (param === null) return null;
  const colon = param.indexOf(":");
  if (colon <= 0 || colon === param.length - 1) return null;
  return { site: param.slice(0, colon), player: param.slice(colon + 1) };
}
