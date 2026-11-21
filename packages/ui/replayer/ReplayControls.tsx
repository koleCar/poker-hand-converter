/**
 * The transport — Tier 1.
 *
 * Design 7 (round 2): no caption, no visible scrub rail, no street or speed
 * chips. The transport is the step buttons and nothing else, and progress
 * through the hand is the soft fill *behind* them, with a notch on its top edge
 * where each street starts. The band's background is a transparent range
 * input, so pressing or dragging anywhere on it that is not a button seeks
 * there (the buttons sit above it); it is also what a keyboard or a screen
 * reader drives, under its own name.
 *
 * Where it sits is the viewer's call (`transportFor`, off the replayer's own
 * box): a full-width strip under the felt on a phone held upright, a glass pill
 * in the bottom-right corner on a phone on its side, and the same pill a size
 * up — with the jumps to either end — on a desktop.
 *
 * Comment and analysis marks are small dots on the band, still buttons that
 * seek, each with its own accessible name.
 *
 * Press and hold anywhere on the band — a button included — grabs the
 * timeline: after `HOLD_MS` the finger scrubs left and right until it lifts,
 * and the button it started on does not fire. A plain press is still the
 * button's (`useHoldToScrub`).
 */

import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import { useUiStrings } from "../i18n";
import type { Street } from "../model/phf";
import type { ReplayFrame } from "../model/replay";
import type { TransportLayout } from "./dropLadder";

interface ReplayControlsProps {
  frames: ReplayFrame[];
  frame: ReplayFrame;
  anchors: Array<{ street: Street; index: number }>;
  /**
   * Marks: comments (#34) or analysed decisions (analysis A1) — frame index,
   * how many, where. A `tone` colours the dot; `ariaLabel` replaces the
   * comment wording when the dot is not about comments.
   */
  marks?: Array<{ index: number; count: number; label: string; tone?: string; ariaLabel?: string }>;
  /** `frame.description`, name-masked: the seek slider's spoken value. */
  caption: string;
  layout: TransportLayout;
  playing: boolean;
  onSeek: (index: number) => void;
  onStep: (delta: number) => void;
  onTogglePlay: () => void;
}

/** How long a press on a button waits before it becomes a scrub. */
const HOLD_MS = 320;
/** A finger that wanders this far (px) before then meant something else. */
const SLOP_PX = 10;

/**
 * Press and hold on the transport's buttons grabs the timeline. The empty band
 * is the range input and scrubs natively; this covers the presses that land on
 * a button (or a mark), which the input under them never sees.
 */
function useHoldToScrub(last: number, onSeek: (index: number) => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const hold = useRef<{
    id: number;
    startX: number;
    startY: number;
    x: number;
    timer: number;
    scrubbing: boolean;
  } | null>(null);
  const swallowClick = useRef(false);
  const seekRef = useRef(onSeek);
  useEffect(() => {
    seekRef.current = onSeek;
  }, [onSeek]);

  const seekAt = useCallback(
    (clientX: number) => {
      const box = ref.current?.getBoundingClientRect();
      if (!box || box.width <= 0 || last <= 0) return;
      const share = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
      seekRef.current(Math.round(share * last));
    },
    [last],
  );

  const end = useCallback(() => {
    const current = hold.current;
    if (!current) return;
    window.clearTimeout(current.timer);
    hold.current = null;
    if (current.scrubbing) {
      ref.current?.removeAttribute("data-scrubbing");
      // The click that follows the lift belongs to the scrub, not the button.
      swallowClick.current = true;
      window.setTimeout(() => {
        swallowClick.current = false;
      }, 0);
    }
  }, []);

  useEffect(() => () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || last <= 0) return;
    const target = event.target as Element;
    // The band itself is the range input, which already scrubs.
    if (!target.closest("button")) return;
    end();
    const id = event.pointerId;
    const x = event.clientX;
    const timer = window.setTimeout(() => {
      const current = hold.current;
      if (!current || current.id !== id) return;
      current.scrubbing = true;
      const el = ref.current;
      if (el) {
        el.setAttribute("data-scrubbing", "true");
        try {
          el.setPointerCapture(id);
        } catch {
          // The pointer may already be gone; the next move or lift ends it.
        }
      }
      navigator.vibrate?.(8);
      seekAt(current.x);
    }, HOLD_MS);
    hold.current = { id, startX: x, startY: event.clientY, x, timer, scrubbing: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = hold.current;
    if (!current || current.id !== event.pointerId) return;
    if (current.scrubbing) {
      event.preventDefault();
      seekAt(event.clientX);
      return;
    }
    current.x = event.clientX;
    if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > SLOP_PX) end();
  };

  const onClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    ref,
    onPointerDown,
    onPointerMove,
    onPointerUp: end,
    onPointerCancel: end,
    // Taking the capture from the button fires this on the button too; only
    // the band losing it ends a scrub.
    onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.target === ref.current) end();
    },
    onClickCapture,
    // A long press would otherwise open the browser's menu on the button.
    onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
  };
}

/** Glyphs, drawn rather than typed (the ⏮ family is an emoji on Android). */
function Glyph({ name }: { name: "first" | "prev" | "play" | "pause" | "next" | "last" }) {
  const filled = name === "first" || name === "last" || name === "play" || name === "pause";
  return (
    <svg
      className={`rp__glyph rp__glyph--${name}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? undefined : 2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "first" ? (
        <>
          <rect x="5" y="5" width="2.5" height="14" rx="1" />
          <path d="M19 5.5v13L9 12z" />
        </>
      ) : name === "last" ? (
        <>
          <rect x="16.5" y="5" width="2.5" height="14" rx="1" />
          <path d="M5 5.5v13L15 12z" />
        </>
      ) : name === "play" ? (
        <path d="M7 4.5v15l12-7.5z" />
      ) : name === "pause" ? (
        <>
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </>
      ) : name === "prev" ? (
        <path d="M15 5l-7 7 7 7" />
      ) : (
        <path d="M9 5l7 7-7 7" />
      )}
    </svg>
  );
}

export function ReplayControls({
  frames,
  frame,
  anchors,
  marks = [],
  caption,
  layout,
  playing,
  onSeek,
  onStep,
  onTogglePlay,
}: ReplayControlsProps) {
  const words = useUiStrings().replayer.controls;
  const last = frames.length - 1;
  const at = (index: number) => `${last > 0 ? (index / last) * 100 : 0}%`;
  // The desk pill is a size up and carries the jumps to either end; a phone's
  // transport is the two steps and play.
  const ends = layout === "desk";
  const holdToScrub = useHoldToScrub(last, onSeek);

  return (
    <div className="rp__transport" data-layout={layout} {...holdToScrub}>
      <div className="rp__progress" aria-hidden="true" style={{ inlineSize: at(frame.index) }} />
      {/* Street starts, on the band's top edge. The first street is where the
          hand begins, so it needs no notch. */}
      {anchors.slice(1).map((anchor) => (
        <span key={anchor.street} className="rp__notch" aria-hidden="true" style={{ insetInlineStart: at(anchor.index) }} />
      ))}
      <input
        className="rp__seek"
        type="range"
        min={0}
        max={last}
        value={frame.index}
        aria-label={words.position}
        aria-valuetext={words.positionValue(frame.index + 1, frames.length, caption)}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
      {marks.map((mark) => (
        <button
          key={mark.index}
          type="button"
          className={`rp__mark${mark.tone ? ` rp__mark--${mark.tone}` : ""}${mark.index === frame.index ? " is-current" : ""}`}
          style={{ insetInlineStart: at(mark.index) }}
          aria-label={mark.ariaLabel ?? words.mark(mark.count, mark.label)}
          title={mark.ariaLabel ?? words.mark(mark.count, mark.label)}
          onClick={() => onSeek(mark.index)}
        />
      ))}
      <div className="rp__playback" role="group" aria-label={words.playback}>
        {ends ? (
          <button
            type="button"
            className="rp__tb"
            onClick={() => onSeek(0)}
            disabled={frame.index === 0}
            aria-label={words.start}
            title={words.startTitle}
          >
            <Glyph name="first" />
          </button>
        ) : null}
        <button
          type="button"
          className="rp__tb"
          onClick={() => onStep(-1)}
          disabled={frame.index === 0}
          aria-label={words.previous}
          title={words.previousTitle}
        >
          <Glyph name="prev" />
        </button>
        <button
          type="button"
          className="rp__tb rp__tb--play"
          onClick={onTogglePlay}
          aria-label={playing ? words.pause : words.play}
          aria-pressed={playing}
          title={words.playTitle}
        >
          <Glyph name={playing ? "pause" : "play"} />
        </button>
        <button
          type="button"
          className="rp__tb"
          onClick={() => onStep(1)}
          disabled={frame.index >= last}
          aria-label={words.next}
          title={words.nextTitle}
        >
          <Glyph name="next" />
        </button>
        {ends ? (
          <button
            type="button"
            className="rp__tb"
            onClick={() => onSeek(last)}
            disabled={frame.index >= last}
            aria-label={words.end}
            title={words.endTitle}
          >
            <Glyph name="last" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
