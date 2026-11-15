/**
 * The Trainer's table: the replayer's own felt (`ReplayTable`, inside the
 * same `.rp` / `.rp__stage` boxes the replayer and the hand editor use), so a
 * trainer spot looks exactly like a replayed hand - the seat plates, the
 * chips in front of every seat, the pot, the board and the action pills.
 *
 * The hand is played out to the hero's decision a step at a time, quickly,
 * so the chips move as they do in the replayer (a step is the only thing
 * that animates, `useFrameTransition`); the hero's answer is one more step
 * (the chips pushed out, or the cards folded). A whole hand keeps the same
 * table between decisions and steps on from where it stood.
 *
 * The box has one fixed height for every spot and every state: answering,
 * the grade and the feedback below never resize the table.
 */

"use client";

import { useUiStrings } from "@rail/ui/i18n";
import { ReplayTable } from "@rail/ui/replayer/ReplayTable";
import { DEFAULT_REPLAY_SETTINGS, type NameMask } from "@rail/ui/replayer/replaySettings";
import { shapeFor, type TableShape } from "@rail/ui/replayer/seatLayout";
import { createAmountFormatter } from "@rail/ui/replayer/tableMath";
import { useFrameTransition, useReducedMotion } from "@rail/ui/replayer/useFrameTransition";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { toBigBlinds, toDisplayNumber, type PhfAction, type PhfHand } from "../../lib/phf/types";
import { buildReplay, type ReplayFrame, type ReplayStrings, type SeatFrameState } from "../../lib/replay";
import { useTrainerHost } from "./host";
import styles from "./trainer.module.css";

/** The hero's answer, drawn on the table as one more step. */
export interface HeroMove {
  action: "fold" | "check" | "call" | "bet" | "raise";
  /** What the hero has in front after a bet or a raise, in big blinds. */
  toBb?: number;
  allIn?: boolean;
}

/** Each frame is held this share of the replayer's own 1x dwell: the hand so far, at a glance. */
const SPEED = 0.42;
const MIN_HOLD_MS = 200;
const MAX_HOLD_MS = 620;
/** Before the first step, so the table is seen before it moves. */
const FIRST_HOLD_MS = 280;
/** The hero's answer after a jump to the decision. */
const ANSWER_HOLD_MS = 40;

// Positions say who is who; the trainer's screen names ("Hero", "UTG") would repeat them.
const MASK: NameMask = { seat: () => "", text: (value) => value, tableName: null };
const SETTINGS = { ...DEFAULT_REPLAY_SETTINGS, showKnownCards: false, showHeroCards: true };

const round2 = (value: number) => Math.round(value * 100) / 100;
const bbText = (value: number, locale: string) => (Math.round(value * 10) / 10).toLocaleString(locale, { maximumFractionDigits: 1 });
const POST_WORD: Record<string, string> = { "small-blind": "SB", "big-blind": "BB", straddle: "Straddle", ante: "Ante", "bomb-ante": "Ante" };

const STREET_OF = (cards: number) => (cards >= 5 ? "river" : cards === 4 ? "turn" : "flop");

/** Pills cleared: a new street, or the chips swept in. */
const cleared = (seats: SeatFrameState[], extra: Partial<SeatFrameState> = {}) =>
  seats.map((seat) => ({ ...seat, lastAction: null, lastActionTone: "neutral" as const, isActing: false, ...extra }));

/**
 * A first-to-act hero on a new street: the hand stops before anyone acted
 * on it, so the replay has not swept the bets in or turned the cards over.
 * Both are added as the replayer itself would draw them (a sweep, then the
 * street), so the hero's real action later lands on the same frame numbers.
 */
function dealtFrames(frames: ReplayFrame[], board: readonly string[]): ReplayFrame[] {
  const last = frames[frames.length - 1];
  if (!last || board.length <= last.board.length || board.length < 3) return frames;
  const out = [...frames];
  let base = last;
  if (last.seats.some((seat) => seat.bet > 0)) {
    base = {
      ...last,
      index: last.index + 1,
      kind: "collect",
      pot: last.potWithBets,
      potBb: last.potWithBetsBb,
      pots: last.pots.length > 1 ? last.pots : [{ name: last.pots[0]?.name ?? "Main", amount: last.potWithBets, amountBb: last.potWithBetsBb }],
      seats: cleared(last.seats, { bet: 0, betBb: 0 }),
      actingSeat: null,
      actionIndex: null,
      allInAt: false,
      potAward: null,
    };
    out.push(base);
  }
  out.push({
    ...base,
    index: base.index + 1,
    kind: "street",
    street: STREET_OF(board.length),
    board: [...board],
    seats: cleared(base.seats),
    actingSeat: null,
    actionIndex: null,
  });
  return out;
}

/** The hero's answer as the frame after `base`. */
function moveFrame(base: ReplayFrame, move: HeroMove, bigBlind: number, pill: (move: HeroMove, toBb: number) => string): ReplayFrame {
  const seats = base.seats.map((seat) => ({ ...seat, isActing: false }));
  const hero = seats.find((seat) => seat.isHero);
  if (!hero) return base;
  let potWithBets = base.potWithBets;
  let potWithBetsBb = base.potWithBetsBb;
  if (move.action === "fold") {
    hero.folded = true;
    hero.lastAction = pill(move, 0);
    hero.lastActionTone = "fold";
  } else if (move.action === "check") {
    hero.lastAction = pill(move, 0);
    hero.lastActionTone = "check";
  } else {
    const most = Math.max(0, ...seats.map((seat) => seat.betBb));
    const cap = hero.betBb + hero.stackBb;
    const wanted = move.allIn ? cap : move.action === "call" ? most : (move.toBb ?? most);
    const toBb = round2(Math.min(cap, Math.max(hero.betBb, wanted)));
    const addBb = round2(toBb - hero.betBb);
    hero.betBb = toBb;
    hero.bet = toBb * bigBlind;
    hero.stackBb = round2(Math.max(0, hero.stackBb - addBb));
    hero.stack = hero.stackBb * bigBlind;
    const allIn = hero.stackBb <= 0.005;
    hero.allIn = hero.allIn || allIn;
    hero.lastAction = pill(move, toBb);
    hero.lastActionTone = allIn ? "allin" : move.action === "call" ? "call" : "aggressive";
    potWithBets += addBb * bigBlind;
    potWithBetsBb = round2(potWithBetsBb + addBb);
  }
  return {
    ...base,
    index: base.index + 1,
    kind: "action",
    seats,
    potWithBets,
    potWithBetsBb,
    actingSeat: hero.seatNo,
    actionIndex: null,
    allInAt: false,
    potAward: null,
  };
}

const VOLUNTARY = new Set<string>(["fold", "check", "call", "bet", "raise"]);

/**
 * The frames up to the hero's decision: through the last action taken before
 * it (the replay goes on past the end of the actions - the sweep, the result
 * a hand history carries - which is not where the hero stands).
 */
function toDecision(frames: ReplayFrame[], hand: PhfHand): ReplayFrame[] {
  const last = [...hand.actions].reverse().find((action) => VOLUNTARY.has(action.type));
  let cut = -1;
  if (last) frames.forEach((frame, index) => frame.actionIndex === last.index && (cut = index));
  if (cut < 0) cut = frames.findIndex((frame) => frame.kind === "deal");
  return cut >= 0 ? frames.slice(0, cut + 1) : frames;
}

/** Where the replay starts: the deal preflop; on a later street, the end of the street before it. */
function startOf(frames: ReplayFrame[]): number {
  let street = -1;
  frames.forEach((frame, index) => {
    if (frame.kind === "street") street = index;
  });
  if (street <= 0) return 0;
  return Math.max(0, street - (frames[street - 1]?.kind === "collect" ? 2 : 1));
}

export function TrainerTable({
  hand,
  board = [],
  heroCards,
  move = null,
  waiting = false,
  over = false,
  shown = null,
  compact = false,
  children,
}: {
  hand: PhfHand;
  /** The board at the decision; a first-to-act hero's street has not been turned by the replay yet. */
  board?: readonly string[];
  /** The hero's cards, when the hand itself does not show them. */
  heroCards?: readonly string[];
  /** The hero's answer: one more step on the table. */
  move?: HeroMove | null;
  /** The hero is to act: the hero's seat is lit. */
  waiting?: boolean;
  /** The hand is over: played to its end (the showdown, the pot pushed), not to a decision. */
  over?: boolean;
  /** An opponent's cards turned over (a whole hand's showdown). */
  shown?: { position: string; cards: readonly string[] } | null;
  /** One of several tables: a smaller box. */
  compact?: boolean;
  /** Pinned over the stage (the table's corner). */
  children?: ReactNode;
}) {
  const { t, locale } = useTrainerHost();
  const ui = useUiStrings().replayer;
  const bigBlind = toDisplayNumber(hand.game.bigBlind, hand.game.unit);

  // The pills in big blinds and the trainer's words ("Raise 2.5"), whatever the hand's currency.
  const strings = useMemo<ReplayStrings>(() => {
    const amount = (value: number) => bbText(toBigBlinds(value, hand.game.bigBlind), locale);
    const word = (kind: string) => t.words.leakActions[kind] ?? kind;
    return {
      ...ui.frames,
      foldLabel: word("fold"),
      checkLabel: word("check"),
      actionLabel: (action: PhfAction) => {
        if (POST_WORD[action.type]) return `${POST_WORD[action.type]} ${amount(action.amount)}`;
        if (action.type === "fold" || action.type === "check") return word(action.type);
        if (action.type === "call") return `${word("call")} ${amount(action.streetTotal)}`;
        if (action.type === "bet" || action.type === "raise") return `${word(action.type)} ${amount(action.streetTotal)}`;
        return ui.frames.actionLabel(action, (value) => amount(value));
      },
    };
  }, [ui.frames, t, locale, hand.game.bigBlind]);

  const pill = useMemo(
    () => (m: HeroMove, toBb: number) => {
      const word = t.words.leakActions[m.action] ?? m.action;
      const text = m.action === "fold" || m.action === "check" ? word : `${word} ${bbText(toBb, locale)}`;
      return m.allIn ? strings.allIn(text) : text;
    },
    [t, locale, strings],
  );

  // The hand to the decision, the dealt street, the hero's cards and an opponent's shown cards.
  const decision = useMemo(() => {
    const replay = buildReplay(hand, { strings, openOnDeal: true });
    const built = over ? replay : dealtFrames(toDecision(replay, hand), board);
    const shownAt = built.length - 1;
    return built.map((frame, index) => {
      const seats = frame.seats.map((seat) => {
        let next = seat;
        if (seat.isHero && !seat.cards && heroCards && heroCards.length > 0 && !seat.folded) next = { ...next, cards: [...heroCards], hasCards: true };
        if (index === shownAt && shown && !seat.isHero && seat.position === shown.position && !seat.cards) next = { ...next, cards: [...shown.cards], hasCards: true };
        return next;
      });
      return { ...frame, seats };
    });
    // `board` and `heroCards` are arrays from the spot: their contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hand, strings, over, board.join(""), heroCards?.join(""), shown?.position, shown?.cards.join("")]);

  // The decision frame with the hero lit, and the answer after it.
  const frames = useMemo(() => {
    const last = decision[decision.length - 1];
    if (!last) return decision;
    if (move) return [...decision, moveFrame(last, move, bigBlind, pill)];
    if (!waiting) return decision;
    const lit = { ...last, seats: last.seats.map((seat) => ({ ...seat, isActing: seat.isHero })) };
    return [...decision.slice(0, -1), lit];
  }, [decision, move, waiting, bigBlind, pill]);

  const reduced = useReducedMotion();
  const target = frames.length - 1;
  const [index, setIndex] = useState(() => (reduced ? target : startOf(frames)));
  const [answeredAt, setAnsweredAt] = useState<HeroMove | null>(null);

  // An answer given while the hand is still being played out: straight to the decision, then the answer.
  if (move && answeredAt !== move) {
    setAnsweredAt(move);
    if (index < target - 1) setIndex(target - 1);
  } else if (!move && answeredAt) {
    setAnsweredAt(null);
  }
  const shownIndex = Math.min(index, target);
  const frame = frames[shownIndex];

  // One step at a time to the decision (or the answer); a reduced-motion reader is there at once.
  useLayoutEffect(() => {
    if (index >= target) return;
    if (reduced) {
      setIndex(target);
      return;
    }
    const at = frames[index];
    const hold =
      move && index === target - 1
        ? ANSWER_HOLD_MS
        : index === startOf(frames) && index === 0
          ? FIRST_HOLD_MS
          : Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, (at?.holdMs ?? 600) * SPEED));
    const timer = window.setTimeout(() => setIndex((i) => Math.min(i + 1, target)), hold);
    return () => window.clearTimeout(timer);
  }, [index, target, frames, move, reduced]);

  const motion = useFrameTransition(frame?.index ?? 0);

  // The shape off the stage, as the replayer measures it.
  const stageRef = useRef<HTMLDivElement>(null);
  const [shape, setShape] = useState<TableShape>("classic");
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const box = node.getBoundingClientRect();
      setShape(shapeFor(box.width, box.height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const format = useMemo(() => createAmountFormatter("bb", hand.game.unit, hand.game.bigBlind), [hand.game.unit, hand.game.bigBlind]);
  const tableHand = useMemo(() => ({ game: hand.game, players: [] }), [hand.game]);

  if (!frame) return null;
  return (
    <TableBox compact={compact} shape={shape} motion={motion === "step" ? "step" : "settle"}>
      <div className="rp__stage" ref={stageRef}>
        <ReplayTable hand={tableHand} frame={frame} shape={shape} motion={motion} settings={SETTINGS} mask={MASK} format={format} />
        {children}
      </div>
    </TableBox>
  );
}

/**
 * The fixed box the table sits in, also drawn empty while a spot is dealt,
 * so dealing, answering and the next spot never move what is under it.
 */
export function TableBox({
  compact = false,
  shape = "classic",
  motion = "settle",
  children,
}: {
  compact?: boolean;
  shape?: TableShape;
  motion?: "step" | "settle";
  children: ReactNode;
}) {
  return (
    <div
      className={`rp ${styles.table}`}
      data-shape={shape}
      data-motion={motion}
      data-compact={compact || undefined}
      // The replayer's grid has a header and a transport row; this box has the stage alone.
      // Inline so it outranks `.rp`'s own `--rp-block` whatever order the stylesheets load in.
      style={{ gridTemplateRows: "minmax(0, 1fr)", "--rp-block": "var(--trainer-table-block)" } as CSSProperties}
    >
      {children}
    </div>
  );
}
