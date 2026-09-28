/**
 * The transport — Tier 1.
 *
 * One band at the bottom of the replayer holding the four things you look at
 * on every single step: the live caption, the scrub rail with its street
 * ticks, the playback buttons and the street jumps. None of it is ever behind
 * a tap, and none of it is ever hidden in a panel that can be closed — the
 * caption in particular, because it is both the most-read text in the product
 * and the `aria-live` region, and a live region inside a closable panel
 * announces nothing.
 *
 * What it *can* afford to lose it loses by `data-tier`, the drop ladder from
 * #19: labels on the option buttons first, then the five speed chips (which
 * become one button that cycles), then the street names (which become
 * initials, and keys `1`-`5`). See `dropLadder.ts`.
 */

import type { Street } from "../../lib/phf/types";
import type { ReplayFrame } from "../../lib/replay";
import { speedIsCycled, streetsAreInitials, type ReplayTier } from "./dropLadder";

const SPEEDS = [0.5, 1, 1.5, 2, 4];

const STREET_LABEL: Record<Street, string> = {
  preflop: "Preflop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
};

/** Rung 3 of the ladder. One letter each, and all five are distinct. */
const STREET_INITIAL: Record<Street, string> = {
  preflop: "P",
  flop: "F",
  turn: "T",
  river: "R",
  showdown: "S",
};

interface ReplayControlsProps {
  frames: ReplayFrame[];
  frame: ReplayFrame;
  anchors: Array<{ street: Street; index: number }>;
  /** `frame.description`, name-masked. The `aria-live` text. */
  caption: string;
  tier: ReplayTier;
  playing: boolean;
  speed: number;
  logOpen: boolean;
  resultOpen: boolean;
  /** The hand has reached a showdown, so the result sheet has something in it. */
  resultReady: boolean;
  onSeek: (index: number) => void;
  onStep: (delta: number) => void;
  onTogglePlay: () => void;
  onSpeed: (speed: number) => void;
  onToggleLog: () => void;
  onToggleResult: () => void;
}

export function ReplayControls({
  frames,
  frame,
  anchors,
  caption,
  tier,
  playing,
  speed,
  logOpen,
  resultOpen,
  resultReady,
  onSeek,
  onStep,
  onTogglePlay,
  onSpeed,
  onToggleLog,
  onToggleResult,
}: ReplayControlsProps) {
  const last = frames.length - 1;
  const initials = streetsAreInitials(tier);

  const cycleSpeed = () => {
    const at = SPEEDS.indexOf(speed);
    onSpeed(SPEEDS[(at + 1) % SPEEDS.length] ?? 1);
  };

  return (
    <div className="rp__transport">
      {/*
        The single live region in the replayer. `aria-atomic` because the whole
        sentence is the news, not the word that changed; `polite` because a
        scrub can fire ten of these a second and `assertive` would make the
        replayer unusable with a screen reader on.
      */}
      <p className="rp__caption" aria-live="polite" aria-atomic="true">
        {caption}
      </p>

      <div className="rp__scrub-wrap">
        {/* Street boundaries drawn on the rail so scrubbing is aimed, not blind. */}
        <div className="rp__ticks" aria-hidden="true">
          {anchors.map((anchor) => (
            <span
              key={anchor.street}
              className="rp__tick"
              style={{ left: `${last > 0 ? (anchor.index / last) * 100 : 0}%` }}
            />
          ))}
        </div>
        <input
          className="rp__scrub"
          type="range"
          min={0}
          max={last}
          value={frame.index}
          aria-label="Position in hand"
          aria-valuetext={`Step ${frame.index + 1} of ${frames.length}. ${caption}`}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
      </div>

      <div className="rp__buttons">
        <div className="rp__playback" role="group" aria-label="Playback">
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => onSeek(0)}
            aria-label="Jump to start"
            title="Start (Home)"
          >
            ⏮
          </button>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => onStep(-1)}
            disabled={frame.index === 0}
            aria-label="Previous action"
            title="Back (←)"
          >
            ◀
          </button>
          <button
            type="button"
            className="btn btn--play"
            onClick={onTogglePlay}
            aria-label={playing ? "Pause" : "Play"}
            aria-pressed={playing}
            title="Play / pause (space)"
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => onStep(1)}
            disabled={frame.index >= last}
            aria-label="Next action"
            title="Forward (→)"
          >
            ▶
          </button>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => onSeek(last)}
            aria-label="Jump to end"
            title="End (End)"
          >
            ⏭
          </button>
        </div>

        <div className="rp__streets" role="group" aria-label="Jump to street">
          {anchors.map((anchor, index) => (
            <button
              key={anchor.street}
              type="button"
              className={`chip-btn ${frame.street === anchor.street ? "is-active" : ""}`.trim()}
              aria-pressed={frame.street === anchor.street}
              // The visible text shrinks to an initial at narrow tiers, so the
              // accessible name is stated rather than read off the glyph.
              aria-label={STREET_LABEL[anchor.street]}
              title={`${STREET_LABEL[anchor.street]} (${index + 1})`}
              onClick={() => onSeek(anchor.index)}
            >
              {initials ? STREET_INITIAL[anchor.street] : STREET_LABEL[anchor.street]}
            </button>
          ))}
        </div>

        {/* Rung 2: five chips, or one button that cycles through the same five. */}
        {speedIsCycled(tier) ? (
          <div className="rp__speed">
            <button
              type="button"
              className="chip-btn"
              aria-label={`Playback speed, ${speed} times. Activate for the next speed.`}
              title="Playback speed"
              onClick={cycleSpeed}
            >
              {speed}x
            </button>
          </div>
        ) : (
          <div className="rp__speed" role="group" aria-label="Playback speed">
            {SPEEDS.map((value) => (
              <button
                key={value}
                type="button"
                className={`chip-btn ${speed === value ? "is-active" : ""}`.trim()}
                aria-pressed={speed === value}
                aria-label={`${value} times speed`}
                onClick={() => onSpeed(value)}
              >
                {value}x
              </button>
            ))}
          </div>
        )}

        <div className="rp__opts">
          {/* Unit and card visibility live behind the gear in the header. */}
          {resultReady ? (
            <button
              type="button"
              className={`chip-btn ${resultOpen ? "is-active" : ""}`.trim()}
              aria-pressed={resultOpen}
              aria-haspopup="dialog"
              aria-label="Result"
              title="Result"
              onClick={onToggleResult}
            >
              <span aria-hidden="true">🏆</span>
              {/* Rung 1: the label goes, the icon and the name stay. */}
              <span className="rp__opt-label">Result</span>
            </button>
          ) : null}
          <button
            type="button"
            className={`chip-btn ${logOpen ? "is-active" : ""}`.trim()}
            aria-pressed={logOpen}
            aria-haspopup="dialog"
            aria-label="Action log"
            title="Action log (L)"
            onClick={onToggleLog}
          >
            <span aria-hidden="true">☰</span>
            <span className="rp__opt-label">Log</span>
          </button>
        </div>
      </div>
    </div>
  );
}
