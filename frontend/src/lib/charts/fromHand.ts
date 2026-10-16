/**
 * A parsed hand (`PhfHand`) into the `PreflopSpot` of one hero decision.
 *
 * Reads only the action stream, the players and the game header - the same
 * rule as `lib/stats/context.ts`: straddles and antes are detected from the
 * stream, not from `game.straddles` / `game.anteModel`, which most parsers
 * leave at their defaults.
 */

import { assignPositions, isPostingAction, positionRing, type PhfAction, type PhfHand, type Position } from "../phf/types";
import { lookupPreflop, rareLineDepthSets, uncoveredDepthSets, type PreflopActionInput, type PreflopSpot } from "./lookup";
import { CHART_SETS, pickChartSet, type ChartLibrary, type ChartSetSpec } from "./registry";

export type SpotFromHandResult =
  | {
      ok: true;
      spot: PreflopSpot;
      /** The hero's decision itself. */
      heroAction: PreflopActionInput;
      /** Hole cards, when known. */
      heroCards: string[] | null;
      /** Index of the decision in `hand.actions`. */
      actionIndex: number;
    }
  | { ok: false; reason: "game" | "bomb-pot" | "no-positions" | "no-hero" | "no-decision"; detail: string };

const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);

/**
 * The spot for the hero's `nth` preflop decision (0 = the first). `heroSeat`
 * defaults to the player marked as hero. Does not mutate `hand`.
 */
export function preflopSpotFromHand(hand: PhfHand, nth = 0, heroSeat?: number): SpotFromHandResult {
  const game = hand.game;
  if (game.variant !== "holdem" || game.limit !== "nl" || game.format !== "cash") {
    return { ok: false, reason: "game", detail: `${game.variant} ${game.limit} ${game.format} is not NLHE cash` };
  }
  if (hand.actions.some((a) => a.type === "bomb-ante")) {
    return { ok: false, reason: "bomb-pot", detail: "bomb pot: no preflop betting" };
  }

  // Positions, without touching the caller's hand.
  let players = hand.players;
  if (players.every((p) => p.position === null)) {
    const copy: PhfHand = { ...hand, players: hand.players.map((p) => ({ ...p })) };
    assignPositions(copy);
    players = copy.players;
  }
  const position = new Map<number, Position>();
  for (const p of players) {
    if (p.position) position.set(p.seat, p.position);
  }
  if (!position.size) {
    return { ok: false, reason: "no-positions", detail: "button unknown; positions cannot be resolved" };
  }
  // A dead button: the live names of the same table (analysis/24).
  const live = liveNames([...position.values()]);
  if (live) for (const [seat, name] of position) position.set(seat, live.get(name) as Position);

  const heroPlayer = heroSeat === undefined ? players.find((p) => p.isHero) : players.find((p) => p.seat === heroSeat);
  if (!heroPlayer || !position.has(heroPlayer.seat)) {
    return { ok: false, reason: "no-hero", detail: "no hero seat with a position" };
  }

  const bb = game.bigBlind;
  // Straddles in the order posted: who, and to how much (the street total).
  const straddles: { position: Position; toBb: number }[] = [];
  for (const action of hand.actions) {
    if (action.type !== "straddle" || action.seat === null) continue;
    const at = position.get(action.seat);
    if (at) straddles.push({ position: at, toBb: action.streetTotal / bb });
  }
  const straddled = hand.actions.some((a) => a.type === "straddle");
  // Big blinds posted from a seat other than the blinds (sitting in, or back from a missed blind), in chips.
  const posts = new Map<number, number>();
  for (const action of hand.actions) {
    if (action.street !== "preflop" || action.seat === null) continue;
    if (action.type === "big-blind" || action.type === "post" || action.type === "missed-blind") {
      posts.set(action.seat, (posts.get(action.seat) ?? 0) + action.amount);
    }
  }
  const postedLimps: Position[] = [];
  const actions: PreflopActionInput[] = [];
  let seen = 0;
  for (const action of hand.actions) {
    if (action.street !== "preflop" || action.seat === null) continue;
    if (isPostingAction(action.type) || !DECISIONS.has(action.type)) continue;
    const pos = position.get(action.seat);
    if (!pos) continue;
    const input: PreflopActionInput = {
      position: pos,
      type: action.type === "bet" ? "raise" : (action.type as PreflopActionInput["type"]),
    };
    // A live big blind posted from another seat, then checked: that player has
    // a big blind in and nothing more to match, which is a limp in chips
    // (analysis/24, `postedLimp`). Not the hero's own check: the poster's fold
    // would cost the post, a limper's nothing, so that decision is not a limp's.
    const own = action.seat === heroPlayer.seat && seen === nth;
    if (!own && postedLimp(action, pos, posts.get(action.seat) ?? 0, bb)) {
      input.type = "call";
      input.toBb = 1;
      postedLimps.push(pos);
    }
    if (action.type === "call" || action.type === "raise" || action.type === "bet") {
      input.toBb = action.streetTotal / bb;
    }
    if (action.allIn) input.allIn = true;
    if (action.seat === heroPlayer.seat) {
      if (seen === nth) {
        const stacksBb: Partial<Record<Position, number>> = {};
        for (const p of players) {
          const at = position.get(p.seat);
          if (at) stacksBb[at] = p.startingStack / bb;
        }
        const cards = heroPlayer.holeCards.length === 2 ? [...heroPlayer.holeCards] : null;
        return {
          ok: true,
          spot: {
            positions: [...position.values()],
            hero: position.get(heroPlayer.seat) as Position,
            actions,
            stacksBb,
            ante: hand.actions.some((a) => a.type === "ante"),
            straddle: straddled,
            ...(straddled ? { straddles } : {}),
            ...(live ? { deadButton: true } : {}),
            ...(postedLimps.length ? { postedLimps: [...postedLimps] } : {}),
          },
          heroAction: input,
          heroCards: cards,
          actionIndex: action.index,
        };
      }
      seen += 1;
    }
    actions.push(input);
  }
  return { ok: false, reason: "no-decision", detail: `the hero has no preflop decision #${nth}` };
}

/**
 * A dead button's position names onto the live names of the same table
 * (analysis/24), or null when the button is not dead. `assignPositions` names
 * the live seats behind a dead button against a ring one longer with the
 * button's slot dropped - three players are SB, BB and CO - so a set of names
 * without a BTN that is exactly `positionRing(k + 1)` less its last name is a
 * dead button. The game is then a `k`-handed one: the last seat before the
 * small blind acts last before the blinds and last after the flop, which is
 * the button's place. Each name maps to the live ring's name at the same
 * place in the order of play (SB, BB, UTG, ...).
 */
export function liveNames(names: readonly Position[]): Map<Position, Position> | null {
  const k = names.length;
  if (k < 3 || names.includes("BTN")) return null;
  const dead = positionRing(k + 1).slice(0, k);
  const given = new Set(names);
  if (given.size !== k || dead.some((name) => !given.has(name))) return null;
  const ring = positionRing(k);
  return new Map(dead.map((name, i) => [name, ring[i]] as const));
}

/**
 * Whether a preflop check is a poster's limp (analysis/24): a seat other than
 * the blinds that posted exactly one live big blind (no dead money) checks
 * with exactly that in. In chips that is a limp. In range it is not quite:
 * the poster holds any two cards, the charts' limper the limp range their
 * tremble trained, so a grade read this way is capped (`posted-blind`).
 */
export function postedLimp(action: PhfAction, position: Position, postedChips: number, bigBlind: number): boolean {
  if (action.type !== "check" || position === "SB" || position === "BB" || bigBlind <= 0) return false;
  return Math.abs(postedChips - bigBlind) < 1e-9 && Math.abs(action.streetTotal - bigBlind) < 1e-9;
}

/**
 * The ids of the library sets a hand needs: one per table and depth its
 * players' preflop decisions are looked up at - the hero's, graded, and every
 * opponent's, whose chart ranges the postflop analysis starts from; a
 * straddled hand's is the straddle set, when one fits (A2e). A caller
 * loads these (`ensureChartSets`) before analysing the hand, since the lookup
 * itself is synchronous.
 */
export function requiredChartSets(hand: PhfHand, specs: readonly ChartSetSpec[] = CHART_SETS): string[] {
  const out = new Set<string>();
  for (const player of hand.players) {
    for (let nth = 0; ; nth += 1) {
      const found = preflopSpotFromHand(hand, nth, player.seat);
      if (!found.ok) break;
      if (found.spot.ante) return [];
      const pick = pickChartSet(specs, found.spot);
      if (pick.ok) out.add(pick.spec.id);
    }
  }
  return [...out].sort();
}

/**
 * The neighbouring-depth sets a hand's decisions may be read on: those of its
 * `rare-line` decisions (`rareLineDepthSets`), read there when graded
 * (`LookupOptions.rareLineDepth`) and for the opponents' ranges, and, since
 * analysis/18, those of decisions at a depth no set covers
 * (`uncoveredDepthSets`), read there for the opponents' ranges only
 * (`LookupOptions.uncoveredDepth`). Whether a line is rare is only known
 * from the set that answers it, so this needs the sets `requiredChartSets`
 * lists already loaded: a caller loads those first, then these. Every
 * player's decisions are read, like `requiredChartSets`, so whichever seat is
 * graded or walked finds its set.
 */
export function rareLineChartSets(hand: PhfHand, library: ChartLibrary): string[] {
  const out = new Set<string>();
  for (const player of hand.players) {
    for (let nth = 0; ; nth += 1) {
      const found = preflopSpotFromHand(hand, nth, player.seat);
      if (!found.ok) break;
      const lookup = lookupPreflop(library, found.spot, null, null);
      if (!lookup.ok && lookup.reason === "stack-depth") {
        for (const spec of uncoveredDepthSets(library.specs, found.spot)) out.add(spec.id);
        continue;
      }
      if (lookup.ok || lookup.reason !== "rare-line") continue;
      const pick = pickChartSet(library.specs, found.spot);
      if (!pick.ok) continue;
      for (const spec of rareLineDepthSets(library.specs, pick.spec, pick.effectiveBb)) out.add(spec.id);
    }
  }
  return [...out].sort();
}
