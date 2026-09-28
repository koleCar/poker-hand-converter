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
 *
 * ## Three modes
 *
 * `full` is the standalone page and is what everything below describes.
 *
 * `embed` is the same replayer in somebody else's layout — a forum post, a feed
 * item. It gives up the header (its three crumbs are in the post above it) and
 * every Tier-2 overlay (a modal `<dialog>` opened from inside a feed covers the
 * whole page, which is not what a reader scrolling past asked for), keeps the
 * felt and the transport, and takes its height from its slot instead of the
 * viewport. Because the whole layout is already driven by container queries off
 * the stage and by `data-tier` off the replayer's own width, that costs one CSS
 * declaration: `--rp-block: 100%`.
 *
 * `card` is **not this component** — see `ReplayCard`. `ReplayViewer` dispatches
 * to it rather than branching internally, because the very first thing this
 * component does is `buildReplay(hand)`, and a hook cannot be skipped. A feed
 * with twenty-five posts in it must not run twenty-five replays; making the
 * card a separate module is what makes that structurally true rather than
 * carefully maintained.
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type PhfHand } from "../../lib/phf/types";
import { buildReplay, streetAnchors, type ReplayFrame } from "../../lib/replay";
import { ActionLogSheet } from "./ActionLogSheet";
import { HandInfoSheet } from "./HandInfoSheet";
import { ReplayCard } from "./ReplayCard";
import { ReplayControls } from "./ReplayControls";
import { ReplaySettingsMenu } from "./ReplaySettingsMenu";
import { ReplayTable } from "./ReplayTable";
import { shapeFor, type TableShape } from "./seatLayout";
import { ShortcutSheet } from "./ShortcutSheet";
import { ShowdownStrip } from "./ShowdownStrip";
import { durationToken, easingToken } from "./motionTokens";
import { tierFor, type ReplayTier } from "./dropLadder";
import { gameLabel, stakesLabel } from "./handFacts";
import {
  encodePosition,
  frameIndexForPosition,
  positionOfFrame,
  readPositionFromUrl,
  writePositionToUrl,
  type ReplayPosition,
} from "./position";
import { useFrameTransition, useReducedMotion } from "./useFrameTransition";
import {
  createNameMask,
  loadReplaySettings,
  saveReplaySettings,
  unitOf,
  type ReplaySettings,
} from "./replaySettings";
import { createAmountFormatter, firstAwardIndex, hasShowdownResult } from "./tableMath";

export type ReplayMode = "full" | "embed" | "card";

/**
 * What an owner can do to a replayer it does not render the controls for.
 *
 * Everything is stated in `ReplayPosition`, never in frame indices: a forum
 * comment that says "seek to a17" has to keep meaning the same moment after the
 * next parser fix, and an index would not. See `position.ts`.
 */
export interface ReplayViewerHandle {
  seek: (position: ReplayPosition) => void;
  play: () => void;
  pause: () => void;
  position: () => ReplayPosition;
}

interface ReplayViewerProps {
  hand: PhfHand;
  /** Room the hand was played in; the header's first crumb when known. */
  site?: string | null;
  onClose?: () => void;
  /** `card` mode only: what pressing the card does. Omit for a static preview. */
  onOpen?: () => void;
  /** Rendered first in the header's icon row — the share button in practice. */
  headerExtra?: React.ReactNode;
  /** See the module comment. Defaults to the standalone replayer. */
  mode?: ReplayMode;
  /** Where to open. Resolved lossy-tolerantly; see `frameIndexForPosition`. */
  initialPosition?: ReplayPosition | null;
  /** Seat the surrounding post is about. Ringed on the felt; picked on a card. */
  focusSeat?: number | null;
  /**
   * Fires when the reader settles somewhere new — debounced, and never while
   * autoplay is running. See `POSITION_DEBOUNCE`.
   */
  onPositionChange?: (position: ReplayPosition) => void;
  /**
   * Whether the replayer owns `?t=` in the address bar.
   *
   * Defaults to true in `full` mode, which is the standalone page: the URL is
   * the page's own, so keeping it pointed at the moment on screen is what makes
   * "copy the address" mean "copy this moment". False everywhere else, and
   * unconditionally false for `embed` — a feed with three replayers in it would
   * otherwise have three writers fighting over one query string.
   */
  urlSync?: boolean;
  /** `card` mode only: reveal the pot. Off by default, per #23. */
  spoilers?: boolean;
  ref?: React.Ref<ReplayViewerHandle>;
}

const SPEED_KEY = "phc.replayer.speed";

/**
 * How long the reader has to stop moving before the position is published.
 *
 * Dragging the scrub rail fires a change per pixel and autoplay fires one per
 * frame; either would turn `history.replaceState` into a hot loop and, for a
 * forum embed, would fire `onPositionChange` at sixty hertz at whatever the
 * host decided to do with it. Autoplay is excluded outright rather than merely
 * debounced — an address bar that rewrites itself while you watch is not a
 * feature, and where playback *stopped* is the only moment anyone wants to
 * link to.
 */
const POSITION_DEBOUNCE = 250;

/**
 * How much longer autoplay holds on the frame before an all-in runout.
 *
 * Everyone is committed and the rest of the board is about to land in one go;
 * at 1x the old timing flicked from the last call straight through three
 * streets, which is the one moment in a hand that deserves a pause.
 */
const ALL_IN_BEAT = 2.2;

/**
 * How much longer every frame is held under `prefers-reduced-motion`.
 *
 * The holds in the frame contract were timed against the motion: a sweep, a
 * card landing and a pot going out are each an event that says "something just
 * changed, look here". With the positional motion gone those cues are gone,
 * and the only thing left to read a change by is the numbers — so the numbers
 * get more time to be read.
 */
const REDUCED_HOLD = 1.2;

/**
 * The crossfade a reduced-motion reader gets instead of motion.
 *
 * Not nothing, deliberately. Deleting every transition leaves the felt
 * teleporting between two states with no acknowledgement that anything
 * happened at all, which is worse than the animation it replaced; ~100ms of
 * opacity is enough to say "that was a change" without moving anything.
 */
const CROSSFADE_FROM = 0.45;

/**
 * Remembers that the result sheet has already presented itself for this hand.
 *
 * `sessionStorage`, so it survives a scrub back and forth and a re-open in the
 * same sitting but does not follow the reader into next week — the sheet
 * should still introduce itself the first time they open the hand again.
 */
function resultSheetSeen(handKey: string): boolean {
  try {
    return window.sessionStorage.getItem(`phc.replayer.result.${handKey}`) === "1";
  } catch {
    return false;
  }
}

function markResultSheetSeen(handKey: string): void {
  try {
    window.sessionStorage.setItem(`phc.replayer.result.${handKey}`, "1");
  } catch {
    // Private mode: the sheet presents itself once per render session instead.
  }
}

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
 * Watches the replayer's own box and reports which rungs of the drop ladder
 * have fired.
 *
 * Measured off `.rp` rather than the viewport, so a replayer in a 480px forum
 * column behaves like a phone without being told it is one — and answered here
 * rather than in a container query because the transport has to choose between
 * two *different controls* for playback speed, which no stylesheet can do. The
 * answer is published as `data-tier` so the CSS side of the ladder reads the
 * same number rather than deriving a second one. See `dropLadder.ts`.
 */
function useReplayTier(ref: React.RefObject<HTMLDivElement | null>): ReplayTier {
  const [tier, setTier] = useState<ReplayTier>("lg");

  useMeasureEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => setTier(tierFor(node.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return tier;
}

/**
 * The frames the board is running out over, if the hand has one.
 *
 * `allInAt` marks the single frame *before* a runout — the last moment the
 * table is still "before" the board goes out — and the streets that follow it
 * are the runout itself. The two together are the stretch over which nobody is
 * acting any more: the beat is held, the seat plates dim, and the board comes
 * out on its own.
 */
function runoutWindow(frames: ReplayFrame[]): { start: number; end: number } | null {
  const start = frames.findIndex((entry) => entry.allInAt);
  if (start < 0) {
    return null;
  }
  let end = start;
  while (end + 1 < frames.length && frames[end + 1].kind === "street") {
    end += 1;
  }
  return { start, end };
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

/**
 * The mode switch, and the only thing in this file that is allowed to be a
 * branch rather than a prop.
 *
 * It holds no hooks on purpose: `ReplayStage` builds the frames in its first
 * one, so "card mode must not build frames" can only be true if card mode never
 * reaches it. A feed should import `ReplayCard` directly and skip this shim —
 * it is here so a caller that is switching between the three modes has one
 * component to switch on.
 */
export function ReplayViewer(props: ReplayViewerProps) {
  if (props.mode === "card") {
    return (
      <ReplayCard
        hand={props.hand}
        focusSeat={props.focusSeat}
        spoilers={props.spoilers}
        onOpen={props.onOpen}
      />
    );
  }
  return <ReplayStage {...props} />;
}

function ReplayStage({
  hand,
  site,
  onClose,
  headerExtra,
  mode = "full",
  initialPosition,
  focusSeat = null,
  onPositionChange,
  urlSync,
  ref,
}: ReplayViewerProps) {
  const embed = mode === "embed";
  // `embed` never writes: see `ReplayViewerProps.urlSync`.
  const addressable = !embed && (urlSync ?? mode === "full");

  const frames = useMemo(() => buildReplay(hand), [hand]);
  const anchors = useMemo(() => streetAnchors(frames), [frames]);
  // Street markers are already the chips above the scrubber and the board on
  // the felt; in the log they were three-quarters noise.
  const logFrames = useMemo(() => frames.filter((entry) => entry.kind !== "street"), [frames]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const shape = useStageShape(stageRef);
  const tier = useReplayTier(rootRef);
  /** False until the first frame has been painted: a mount is not a change. */
  const settled = useRef(false);

  // Opening position, resolved once. `initialPosition` wins over the URL so a
  // server render (App Router, `searchParams`) and a client render cannot
  // disagree about where the hand opens; the URL is only consulted when nobody
  // told us, which is the standalone page reading its own address.
  const [index, setIndex] = useState(() =>
    frameIndexForPosition(frames, initialPosition ?? (addressable ? readPositionFromUrl() : null)),
  );
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(() =>
    readStored(SPEED_KEY, (raw) => (Number.isFinite(Number(raw)) ? Number(raw) : null), 1),
  );
  const [settings, setSettings] = useState<ReplaySettings>(loadReplaySettings);

  // The four Tier-2 overlays. Held here rather than inside each sheet so the
  // key handler can tell when one of them owns the keyboard.
  const [logOpen, setLogOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);

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

  const last = frames.length - 1;
  const frame = frames[Math.min(index, last)];
  const awardAt = useMemo(() => firstAwardIndex(frames), [frames]);
  const caption = mask.text(frame.description);

  // The two questions every animation in the subtree is answered by. `motion`
  // is `"step"` only when the viewer advanced by exactly one frame; everything
  // else — a scrub, a jump, a reverse, a reduced-motion reader — renders the
  // destination and moves nothing.
  const reduced = useReducedMotion();
  const motion = useFrameTransition(frame.index);
  const runout = useMemo(() => runoutWindow(frames), [frames]);
  const inRunout = runout !== null && frame.index >= runout.start && frame.index <= runout.end;

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

  // The sheet presents itself once, when the replay first reaches a showdown
  // it has something to say about, and then never again for this hand in this
  // session. Decided during the render that notices the change rather than in
  // an effect, which would paint one frame of the answer before covering it.
  const [wasReady, setWasReady] = useState(false);
  if (wasReady !== resultReady) {
    setWasReady(resultReady);
    // Never in an embed: a sheet that presents itself unasked is a modal
    // `<dialog>` over somebody else's page, opened by a replayer the reader may
    // only have scrolled past.
    if (!embed && resultReady && !resultSheetSeen(hand.meta.handKey)) {
      markResultSheetSeen(hand.meta.handKey);
      setResultOpen(true);
    }
  }
  const showResult = !embed && resultReady && resultOpen;
  // Only the *modal* sheets take the keyboard. The log is deliberately not one
  // of them: it is a transcript you read while stepping, so swallowing the
  // arrow keys would make the panel you opened to follow the hand the reason
  // you cannot follow it. See `OverlayProps.modal`.
  const modalOverlayOpen = infoOpen || settingsOpen || keysOpen || showResult;

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

  /* ------------------------------------------------------- position out - */

  const position = useMemo(() => positionOfFrame(frame), [frame]);
  const encoded = encodePosition(position);
  /** The position the replayer opened at. A mount is not a change. */
  const [openedAt] = useState(encoded);
  const published = useRef<string | null>(null);

  // Held in a ref so a host that passes a fresh arrow function every render —
  // which is most of them — does not restart the debounce on every render.
  const notify = useRef(onPositionChange);
  useEffect(() => {
    notify.current = onPositionChange;
  });

  useEffect(() => {
    // Autoplay is excluded, not throttled: sixty `replaceState` calls on the
    // way to the river is a hot loop, and the only moment worth linking to is
    // the one playback stopped on. See `POSITION_DEBOUNCE`.
    if (playing) {
      return;
    }
    // Nothing has moved yet. Publishing here would put `?t=start` on the
    // address of every page that happens to contain a replayer.
    if (published.current === null && encoded === openedAt) {
      return;
    }
    const timer = window.setTimeout(() => {
      published.current = encoded;
      notify.current?.(position);
      if (addressable) {
        writePositionToUrl(position);
      }
    }, POSITION_DEBOUNCE);
    return () => window.clearTimeout(timer);
  }, [encoded, position, playing, addressable, openedAt]);

  useImperativeHandle(
    ref,
    () => ({
      seek: (target: ReplayPosition) => seek(frameIndexForPosition(frames, target)),
      // Same rule the play button follows: at the end, `play()` means "again".
      // A host that calls it and sees nothing move has no way to tell that from
      // a broken handle.
      play: () => {
        if (index >= last) {
          setIndex(0);
        }
        setPlaying(true);
      },
      pause: () => setPlaying(false),
      position: () => position,
    }),
    [frames, seek, position, index, last],
  );

  /**
   * The scrub escape hatch.
   *
   * `data-motion` stops the *next* animation from starting; this finishes the
   * ones already under way. Without it a jump lands on a felt that is still
   * mid-sweep for the frame it left — the attribute cannot retroactively
   * un-start a 460ms flight — and the two together are what make "render the
   * destination" true rather than nearly true.
   *
   * Before paint, so the finished state is what the reader sees first.
   */
  useMeasureEffect(() => {
    const node = stageRef.current;
    if (motion === "step" || !node || typeof node.getAnimations !== "function") {
      return;
    }

    for (const animation of node.getAnimations({ subtree: true })) {
      // An infinite effect — the acting pulse — has no end to jump to, and
      // `finish()` throws rather than saying so. Cancelling is the same thing
      // for something whose only job is to loop.
      if (animation.effect?.getComputedTiming().iterations === Infinity) {
        animation.cancel();
      } else {
        animation.finish();
      }
    }

    // Reduced motion trades the travel for an acknowledgement. Started after
    // the sweep above so it is not immediately finished by it, and driven from
    // here rather than from a stylesheet because the stylesheet's animations
    // are exactly what this mode has switched off.
    if (reduced && settled.current && typeof node.animate === "function") {
      node.animate([{ opacity: CROSSFADE_FROM }, { opacity: 1 }], {
        duration: durationToken(node, "--dur-2", 120),
        easing: easingToken(node, "--ease-standard", "cubic-bezier(0.2, 0, 0, 1)"),
      });
    }
    settled.current = true;
  }, [motion, frame.index, reduced]);

  useEffect(() => {
    if (!playing || index >= last) {
      return;
    }
    const current = frames[index];
    const hold = Math.max(
      120,
      (current.holdMs * (current.allInAt ? ALL_IN_BEAT : 1) * (reduced ? REDUCED_HOLD : 1)) / speed,
    );
    const timer = window.setTimeout(() => {
      const next = index + 1;
      setIndex(next);
      // Stop at the award frame instead of looping.
      if (next >= last) {
        setPlaying(false);
      }
    }, hold);
    return () => window.clearTimeout(timer);
  }, [playing, index, last, frames, speed, reduced]);

  /**
   * The keyboard map — scoped to this replayer, not to the window.
   *
   * The old handler was a `window` listener, which is wrong the moment there
   * are two replayers on a forum page (both would answer every arrow key) or a
   * comment box has focus and the reader types "b". This is `onKeyDown` on the
   * root instead, so a key only arrives if it was pressed inside this
   * replayer's subtree — and `document.activeElement` is checked on top of
   * that, because an overlay is a DOM descendant even while it is painting in
   * the top layer.
   *
   * The map is the one in `shortcuts.ts`, which is also what `ShortcutSheet`
   * prints on `?`; the two are meant to be read side by side.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)
      ) {
        // The scrub rail is an `<input type=range>` and owns the arrow keys.
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      // A modal sheet owns the keyboard; Escape is the dialog's own.
      if (modalOverlayOpen) {
        return;
      }
      // The log is non-modal, so `<dialog>` gives it no Escape of its own and
      // focus never left the replayer. Close it from here instead.
      if (logOpen && event.key === "Escape") {
        event.preventDefault();
        setLogOpen(false);
        return;
      }
      const root = rootRef.current;
      if (!root || !root.contains(document.activeElement)) {
        return;
      }

      // `1`-`5` jump to a street, in the order the hand actually played them,
      // so `3` is the turn on a hand that saw one and out of range on a hand
      // that did not.
      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 5) {
        const anchor = anchors[digit - 1];
        if (anchor) {
          event.preventDefault();
          seek(anchor.index);
        }
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
        case "h":
        case "H":
          changeSettings({ showHeroCards: !settings.showHeroCards });
          break;
        // The three overlay keys are the Tier-2 sheets, which an embed does not
        // have. Silently doing nothing is the right answer rather than opening
        // a modal over the host page.
        case "l":
        case "L":
          if (embed) break;
          event.preventDefault();
          setLogOpen(true);
          break;
        case "i":
        case "I":
          if (embed) break;
          event.preventDefault();
          setInfoOpen(true);
          break;
        case "?":
          if (embed) break;
          event.preventDefault();
          setKeysOpen(true);
          break;
        default:
          break;
      }
    },
    [
      anchors,
      modalOverlayOpen,
      logOpen,
      step,
      seek,
      togglePlay,
      changeSettings,
      settings,
      last,
      embed,
    ],
  );

  return (
    <div
      className="rp"
      ref={rootRef}
      data-shape={shape}
      // Which rungs of the drop ladder have fired. The stylesheet reads this
      // rather than deriving a second answer from a container query.
      data-tier={tier}
      // `full` or `embed`. The stylesheet reads it for exactly one declaration
      // — `--rp-block: 100%` — because everything else that would need to
      // change is already a container query off the stage or off `data-tier`.
      data-mode={mode}
      // One attribute the whole subtree's motion hangs off, so "does this
      // animate" is answered once, in one place, by one CSS rule.
      data-motion={motion}
      data-allin={inRunout ? "true" : undefined}
      // Focusable so the key map has somewhere to be scoped to, and announced
      // as what it is rather than as an unnamed group of divs.
      tabIndex={0}
      role="group"
      aria-roledescription="poker hand replayer"
      aria-label={
        embed
          ? `${gameLabel(hand)} ${stakesLabel(hand)} hand replayer.`
          : `${gameLabel(hand)} ${stakesLabel(hand)} hand replayer. Press question mark for keyboard shortcuts.`
      }
      onKeyDown={onKeyDown}
    >
      {/*
        Tier 1. Three crumbs that orient you and nothing else: everything that
        is constant for the whole hand is in the info sheet, and everything the
        header used to carry that was derived from `hand.results` is a spoiler
        and is gated there (see `spoilersRevealed`).

        The strip is dropped whole at the narrow tier rather than ellipsised
        per item — #58. Four separators around four two-character stubs reads
        as a rendering bug, not as a deliberate omission.

        An embed drops the row entirely — not with `display: none`, which would
        leave three buttons in the accessibility tree that open sheets the embed
        does not render. The crumbs are in the post the embed is sitting in.
      */}
      {embed ? null : (
        <div className="rp__header">
          <div className="rp__meta">
            {site ? <span>{site}</span> : null}
            <span>{stakesLabel(hand)}</span>
            <span>{gameLabel(hand)}</span>
          </div>
          <div className="rp__header-actions">
            {headerExtra}
            <button
              type="button"
              className={`btn btn--icon ${infoOpen ? "is-active" : ""}`.trim()}
              onClick={() => setInfoOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={infoOpen}
              aria-label="Hand info"
              title="Hand info (I)"
            >
              ⓘ
            </button>
            <ReplaySettingsMenu
              settings={settings}
              onChange={changeSettings}
              anchor={stageRef}
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
            />
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
      )}

      {/* The size container. Nothing below it can change its height. */}
      <div className="rp__stage" ref={stageRef}>
        <ReplayTable
          hand={hand}
          frame={frame}
          shape={shape}
          motion={motion}
          settings={settings}
          mask={mask}
          format={format}
          focusSeat={focusSeat}
        />
      </div>

      <ReplayControls
        frames={frames}
        frame={frame}
        anchors={anchors}
        caption={caption}
        tier={tier}
        playing={playing}
        speed={speed}
        logOpen={logOpen}
        resultOpen={showResult}
        // An embed has no sheets, so it has nothing to offer a result button.
        resultReady={!embed && resultReady}
        compact={embed}
        onSeek={seek}
        onStep={step}
        onTogglePlay={togglePlay}
        onSpeed={changeSpeed}
        onToggleLog={() => setLogOpen((current) => !current)}
        onToggleResult={() => setResultOpen((current) => !current)}
      />

      {/*
        Tier 2. Modal `<dialog>`s, so they paint in the top layer: outside the
        stage's size containment, outside the root's `overflow: clip`, and
        therefore structurally incapable of reflowing the felt. They are
        children of the root rather than of the stage so that closing one
        cannot leave a stray box in the middle grid row, and they are anchored
        to the stage so they cover the felt and nothing else on the page.

        None of them exist in an embed, and "not rendered" rather than "hidden"
        is the point: a dialog anchored to a stage halfway down a feed is still
        a top-layer element covering the reader's whole viewport. A replayer
        inside somebody else's page does not get to take the page over.
      */}
      {embed ? null : (
        <>
          <ShowdownStrip
            hand={hand}
            frame={frame}
            awardAt={awardAt}
            settings={settings}
            mask={mask}
            format={format}
            open={showResult}
            onClose={() => setResultOpen(false)}
            anchor={stageRef}
          />

          <ActionLogSheet
            frames={logFrames}
            activeIndex={activeLogIndex}
            mask={mask}
            onSeek={seek}
            open={logOpen}
            onClose={() => setLogOpen(false)}
            anchor={stageRef}
          />

          <HandInfoSheet
            hand={hand}
            frame={frame}
            awardAt={awardAt}
            mask={mask}
            format={format}
            site={site}
            open={infoOpen}
            onClose={() => setInfoOpen(false)}
            anchor={stageRef}
          />

          <ShortcutSheet open={keysOpen} onClose={() => setKeysOpen(false)} anchor={stageRef} />
        </>
      )}
    </div>
  );
}
