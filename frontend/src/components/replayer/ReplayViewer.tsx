/**
 * The replayer shell: header, stage, transport, and the two sheets that float
 * over the stage.
 *
 * The layout contract is that the replayer never scrolls, on any viewport,
 * from a 320px phone to a 4K monitor, at two to ten seats and up to six hole
 * cards. That is a structural property here rather than a set of tuned
 * `max-height` constants: the root is a three-row grid with `overflow: clip`,
 * the middle row is a stage with `container-type: size`, and size containment
 * means the stage's dimensions are computed *without consulting its children*.
 * A sixty-action log, a twenty-two character screen name or a nine-seat ring
 * therefore cannot make it taller. Everything inside is sized in container
 * query units off that box.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  formatAmount,
  toBigBlinds,
  toDisplayNumber,
  type LimitType,
  type PhfHand,
  type Variant,
} from "../../lib/phf/types";
import { buildReplay, streetAnchors } from "../../lib/replay";
import { ActionLogSheet } from "./ActionLogSheet";
import { ReplayControls } from "./ReplayControls";
import { ReplaySettingsMenu } from "./ReplaySettingsMenu";
import { ReplayTable } from "./ReplayTable";
import { shapeFor, type TableShape } from "./seatLayout";
import { ShowdownStrip } from "./ShowdownStrip";
import {
  createNameMask,
  loadReplaySettings,
  saveReplaySettings,
  unitOf,
  type ReplaySettings,
} from "./replaySettings";
import { createAmountFormatter, effectiveStack, hasShowdownResult } from "./tableMath";

interface ReplayViewerProps {
  hand: PhfHand;
  /** Room the hand was played in; the header's first crumb when known. */
  site?: string | null;
  onClose?: () => void;
  /** Rendered first in the header's icon row — the share button in practice. */
  headerExtra?: React.ReactNode;
}

const SPEED_KEY = "phc.replayer.speed";

/**
 * How much longer autoplay holds on the frame before an all-in runout.
 *
 * Everyone is committed and the rest of the board is about to land in one go;
 * at 1x the old timing flicked from the last call straight through three
 * streets, which is the one moment in a hand that deserves a pause.
 */
const ALL_IN_BEAT = 2.2;

const VARIANT_LABEL: Record<Variant, string> = {
  holdem: "Hold’em",
  omaha: "Omaha",
  omaha5: "5-card Omaha",
  omaha6: "6-card Omaha",
  shortdeck: "Short deck",
  stud: "Stud",
  razz: "Razz",
  draw: "Draw",
  other: "",
};

const LIMIT_LABEL: Record<LimitType, string> = { nl: "NL", pl: "PL", fl: "FL" };

/**
 * `useLayoutEffect` on the client, `useEffect` on the server.
 *
 * The measurement has to land before paint or a phone shows one frame of the
 * `classic` ring before the `tall` one replaces it — but `useLayoutEffect`
 * warns when it is called during a server render, and this component is due to
 * be rendered on a server.
 */
const useMeasureEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Watches the stage and reports which table shape to draw.
 *
 * Deliberately effect-only, and deliberately the *only* place the question is
 * answered: the seat slot table needs the same answer, and a CSS media query
 * plus a JS threshold would drift the first time either was tuned. The server
 * pass renders `classic` and the first client frame corrects it, which is what
 * keeps this safe for the move to Next.
 */
function useStageShape(ref: React.RefObject<HTMLDivElement | null>): TableShape {
  const [shape, setShape] = useState<TableShape>("classic");

  useMeasureEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => {
      const box = node.getBoundingClientRect();
      setShape(shapeFor(box.width, box.height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return shape;
}

/**
 * The facts about the game that are true before a card is dealt.
 *
 * None of these is a spoiler — the felt already shows the stacks and the board,
 * and this is the context needed to read them: which game it is, whether the
 * blinds behave normally (bomb pot, straddle, big-blind ante) and how deep the
 * hand is actually being played.
 */
function gameBadges(hand: PhfHand): string[] {
  const { game, table } = hand;
  const unit = game.unit;
  const decimals = hand.meta.textStyle.decimals;
  const badges: string[] = [];

  const variant = VARIANT_LABEL[game.variant];
  if (variant) {
    badges.push(`${LIMIT_LABEL[game.limit]} ${variant}`);
  }
  if (table.fastFold) {
    badges.push(table.fastFold);
  }
  if (game.bombPot) {
    // No blinds and straight to the flop, so "preflop" never happens.
    badges.push(`Bomb pot ${formatAmount(game.bombPot.ante, unit, decimals)}`);
  }
  switch (game.anteModel) {
    case "big-blind-ante":
      // One post for the whole table, not one per player.
      badges.push(`BB ante ${formatAmount(game.ante, unit, decimals)}`);
      break;
    case "button-ante":
      badges.push(`BTN ante ${formatAmount(game.ante, unit, decimals)}`);
      break;
    case "posted-per-player":
      if (game.ante > 0) {
        badges.push(`Ante ${formatAmount(game.ante, unit, decimals)}`);
      }
      break;
    default:
      break;
  }
  if (game.straddles.length === 1) {
    badges.push(`Straddle ${formatAmount(game.straddles[0].amount, unit, decimals)}`);
  } else if (game.straddles.length > 1) {
    badges.push(`${game.straddles.length} straddles`);
  }
  return badges;
}

function readStored<T>(key: string, parse: (raw: string) => T | null, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (parse(raw) ?? fallback);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode / disabled storage: the preference simply does not persist.
  }
}

export function ReplayViewer({ hand, site, onClose, headerExtra }: ReplayViewerProps) {
  const frames = useMemo(() => buildReplay(hand), [hand]);
  const anchors = useMemo(() => streetAnchors(frames), [frames]);
  // Street markers are already the chips above the scrubber and the board on
  // the felt; in the log they were three-quarters noise.
  const logFrames = useMemo(() => frames.filter((entry) => entry.kind !== "street"), [frames]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const shape = useStageShape(stageRef);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(() =>
    readStored(SPEED_KEY, (raw) => (Number.isFinite(Number(raw)) ? Number(raw) : null), 1),
  );
  const [settings, setSettings] = useState<ReplaySettings>(loadReplaySettings);
  const [logOpen, setLogOpen] = useState(false);
  const [resultClosed, setResultClosed] = useState(false);

  const format = useMemo(
    () =>
      createAmountFormatter(
        unitOf(settings),
        hand.game.unit,
        hand.game.bigBlind,
        hand.meta.textStyle.decimals,
      ),
    [settings, hand.game.unit, hand.game.bigBlind, hand.meta.textStyle.decimals],
  );
  const mask = useMemo(
    () => createNameMask(hand, settings.anonymousNames),
    [hand, settings.anonymousNames],
  );
  const badges = useMemo(() => gameBadges(hand), [hand]);
  // Kept in minor units until the last moment, then handed to the same
  // formatter the felt uses so the bb toggle covers it too.
  const effective = useMemo(() => effectiveStack(hand), [hand]);
  const effectiveDisplay = toDisplayNumber(effective, hand.game.unit);
  const effectiveBb = toBigBlinds(effective, hand.game.bigBlind);

  const last = frames.length - 1;
  const frame = frames[Math.min(index, last)];

  // Street frames are not listed, so while one is on screen the highlight
  // stays on the last action that is — otherwise it blinks out between every
  // street during playback.
  const activeLogIndex = useMemo(() => {
    let active = -1;
    for (const entry of logFrames) {
      if (entry.index > frame.index) {
        break;
      }
      active = entry.index;
    }
    return active;
  }, [logFrames, frame.index]);

  const resultReady = hasShowdownResult(hand, frame);
  // The sheet covers the felt, so it only presents itself unasked where the
  // felt has stopped being able to carry the answer: a compact box draws badge
  // seats with no readable hand, and the sheet is where the cards are.
  const [resultPinned, setResultPinned] = useState(false);
  const resultOpen = resultReady && !resultClosed && shape === "compact";
  const showResult = resultReady && (resultOpen || resultPinned);

  // Scrubbing back out of the showdown re-arms both, so stepping through the
  // hand a second time behaves the same way it did the first. Adjusted during
  // the render that notices the change rather than in an effect, which would
  // paint one frame with the stale sheet still up.
  const [wasReady, setWasReady] = useState(resultReady);
  if (wasReady !== resultReady) {
    setWasReady(resultReady);
    if (!resultReady) {
      setResultClosed(false);
      setResultPinned(false);
    }
  }

  const step = useCallback(
    (delta: number) => {
      setPlaying(false);
      setIndex((current) => Math.max(0, Math.min(last, current + delta)));
    },
    [last],
  );

  const seek = useCallback(
    (next: number) => {
      setPlaying(false);
      setIndex(Math.max(0, Math.min(last, next)));
    },
    [last],
  );

  const togglePlay = useCallback(() => {
    if (index >= last) {
      setIndex(0);
      setPlaying(true);
      return;
    }
    setPlaying((current) => !current);
  }, [index, last]);

  const changeSettings = useCallback((patch: Partial<ReplaySettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveReplaySettings(next);
      return next;
    });
  }, []);

  const changeSpeed = useCallback((next: number) => {
    setSpeed(next);
    writeStored(SPEED_KEY, String(next));
  }, []);

  useEffect(() => {
    if (!playing || index >= last) {
      return;
    }
    const current = frames[index];
    const hold = Math.max(120, (current.holdMs * (current.allInAt ? ALL_IN_BEAT : 1)) / speed);
    const timer = window.setTimeout(() => {
      const next = index + 1;
      setIndex(next);
      // Stop at the award frame instead of looping.
      if (next >= last) {
        setPlaying(false);
      }
    }, hold);
    return () => window.clearTimeout(timer);
  }, [playing, index, last, frames, speed]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          step(1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          step(-1);
          break;
        case " ":
          event.preventDefault();
          togglePlay();
          break;
        case "Home":
          event.preventDefault();
          seek(0);
          break;
        case "End":
          event.preventDefault();
          seek(last);
          break;
        case "b":
        case "B":
          changeSettings({ bigBlinds: !settings.bigBlinds });
          break;
        case "c":
        case "C":
          changeSettings({ showKnownCards: !settings.showKnownCards });
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, seek, togglePlay, changeSettings, settings, last]);

  return (
    <div className="rp" data-shape={shape} data-allin={frame.allInAt ? "true" : undefined}>
      {/* Everything the header used to carry besides these three — hand id,
          game, seat count, effective stack, hero position, date and result —
          is either already on the felt or is a spoiler. */}
      <div className="rp__header">
        <div className="rp__meta">
          {site ? <span>{site}</span> : null}
          {mask.tableName ? <span>{mask.tableName}</span> : null}
          <span>
            {formatAmount(hand.game.smallBlind, hand.game.unit, hand.meta.textStyle.decimals)}/
            {formatAmount(hand.game.bigBlind, hand.game.unit, hand.meta.textStyle.decimals)}
          </span>
          {badges.map((badge) => (
            <span key={badge}>{badge}</span>
          ))}
          {/* The stack the hand is really being played for. Known before the
              deal, so it gives nothing away. */}
          <span>Eff. {format(effectiveDisplay, effectiveBb)}</span>
        </div>
        <div className="rp__header-actions">
          {headerExtra}
          <ReplaySettingsMenu settings={settings} onChange={changeSettings} />
          {onClose ? (
            <button
              type="button"
              className="btn btn--icon"
              onClick={onClose}
              aria-label="Close replayer"
              title="Close"
            >
              ✕
            </button>
          ) : null}
        </div>
      </div>

      {/* The size container. Nothing below it can change its height. */}
      <div className="rp__stage" ref={stageRef}>
        <ReplayTable
          hand={hand}
          frame={frame}
          shape={shape}
          settings={settings}
          mask={mask}
          format={format}
        />

        {showResult ? (
          <ShowdownStrip
            hand={hand}
            frame={frame}
            settings={settings}
            mask={mask}
            format={format}
            onClose={() => {
              setResultClosed(true);
              setResultPinned(false);
            }}
          />
        ) : null}

        {logOpen ? (
          <ActionLogSheet
            frames={logFrames}
            activeIndex={activeLogIndex}
            mask={mask}
            onSeek={seek}
            onClose={() => setLogOpen(false)}
          />
        ) : null}
      </div>

      <ReplayControls
        frames={frames}
        frame={frame}
        anchors={anchors}
        playing={playing}
        speed={speed}
        logOpen={logOpen}
        resultOpen={showResult}
        resultReady={resultReady}
        onSeek={seek}
        onStep={step}
        onTogglePlay={togglePlay}
        onSpeed={changeSpeed}
        onToggleLog={() => setLogOpen((current) => !current)}
        onToggleResult={() => {
          if (showResult) {
            setResultClosed(true);
            setResultPinned(false);
          } else {
            setResultClosed(false);
            setResultPinned(true);
          }
        }}
      />
    </div>
  );
}
