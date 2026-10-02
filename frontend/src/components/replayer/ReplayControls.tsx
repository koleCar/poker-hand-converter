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

import { useDict, useLocale } from "../../lib/i18n/client";
import { INTL_LOCALE } from "../../lib/i18n/dictionaries";
import type { Street } from "../../lib/phf/types";
import type { ReplayFrame } from "../../lib/replay";
import { speedIsCycled, streetsAreInitials, type ReplayTier } from "./dropLadder";

const SPEEDS = [0.5, 1, 1.5, 2, 4];

/**
 * Rung 3 of the ladder. One letter each, and all five are distinct. The street
 * names are the same English poker words in every language we speak, so their
 * initials are too; the full names are in `replayer.controls.streets`.
 */
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
  /**
   * One bar instead of two rows of chips: caption, rail, playback, and nothing
   * else. This is `embed` mode, where the replayer is a block inside somebody
   * else's page — the street chips duplicate the ticks on the rail, the speed
   * chips are a preference nobody sets while scrolling a feed, and the option
   * buttons open sheets an embed does not have. Everything dropped here is
   * still reachable by keyboard, which is the drop ladder's own rule.
   */
  compact?: boolean;
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
  compact = false,
  onSeek,
  onStep,
  onTogglePlay,
  onSpeed,
  onToggleLog,
  onToggleResult,
}: ReplayControlsProps) {
  const words = useDict().replayer.controls;
  const intlLocale = INTL_LOCALE[useLocale()];
  const speedText = (value: number) => value.toLocaleString(intlLocale);
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
          aria-label={words.position}
          aria-valuetext={words.positionValue(frame.index + 1, frames.length, caption)}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
      </div>

      <div className="rp__buttons">
        <div className="rp__playback" role="group" aria-label={words.playback}>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => onSeek(0)}
            aria-label={words.start}
            title={words.startTitle}
          >
            ⏮
          </button>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => onStep(-1)}
            disabled={frame.index === 0}
            aria-label={words.previous}
            title={words.previousTitle}
          >
            ◀
          </button>
          <button
            type="button"
            className="btn btn--play"
            onClick={onTogglePlay}
            aria-label={playing ? words.pause : words.play}
            aria-pressed={playing}
            title={words.playTitle}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => onStep(1)}
            disabled={frame.index >= last}
            aria-label={words.next}
            title={words.nextTitle}
          >
            ▶
          </button>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => onSeek(last)}
            aria-label={words.end}
            title={words.endTitle}
          >
            ⏭
          </button>
        </div>

        {compact ? null : (
        <div className="rp__streets" role="group" aria-label={words.jumpToStreet}>
          {anchors.map((anchor, index) => (
            <button
              key={anchor.street}
              type="button"
              className={`chip-btn ${frame.street === anchor.street ? "is-active" : ""}`.trim()}
              aria-pressed={frame.street === anchor.street}
              // The visible text shrinks to an initial at narrow tiers, so the
              // accessible name is stated rather than read off the glyph.
              aria-label={words.streets[anchor.street]}
              title={`${words.streets[anchor.street]} (${index + 1})`}
              onClick={() => onSeek(anchor.index)}
            >
              {initials ? STREET_INITIAL[anchor.street] : words.streets[anchor.street]}
            </button>
          ))}
        </div>
        )}

        {/* Rung 2: five chips, or one button that cycles through the same five. */}
        {compact ? null : speedIsCycled(tier) ? (
          <div className="rp__speed">
            <button
              type="button"
              className="chip-btn"
              aria-label={words.speedCycle(speedText(speed))}
              title={words.speed}
              onClick={cycleSpeed}
            >
              {speedText(speed)}x
            </button>
          </div>
        ) : (
          <div className="rp__speed" role="group" aria-label={words.speed}>
            {SPEEDS.map((value) => (
              <button
                key={value}
                type="button"
                className={`chip-btn ${speed === value ? "is-active" : ""}`.trim()}
                aria-pressed={speed === value}
                aria-label={words.speedOption(speedText(value))}
                onClick={() => onSpeed(value)}
              >
                {speedText(value)}x
              </button>
            ))}
          </div>
        )}

        {compact ? null : (
        <div className="rp__opts">
          {/* Unit and card visibility live behind the gear in the header. */}
          {resultReady ? (
            <button
              type="button"
              className={`chip-btn ${resultOpen ? "is-active" : ""}`.trim()}
              aria-pressed={resultOpen}
              aria-haspopup="dialog"
              aria-label={words.result}
              title={words.result}
              onClick={onToggleResult}
            >
              <span aria-hidden="true">🏆</span>
              {/* Rung 1: the label goes, the icon and the name stay. */}
              <span className="rp__opt-label">{words.result}</span>
            </button>
          ) : null}
          <button
            type="button"
            className={`chip-btn ${logOpen ? "is-active" : ""}`.trim()}
            aria-pressed={logOpen}
            aria-haspopup="dialog"
            aria-label={words.log}
            title={words.logTitle}
            onClick={onToggleLog}
          >
            <span aria-hidden="true">☰</span>
            <span className="rp__opt-label">{words.logShort}</span>
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
