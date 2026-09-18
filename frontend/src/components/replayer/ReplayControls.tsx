import type { Street } from "../../lib/handParser";
import type { ReplayFrame } from "../../lib/replay";
import type { AmountUnit } from "./tableMath";

const SPEEDS = [0.5, 1, 1.5, 2, 4];

export const STREET_LABEL: Record<Street, string> = {
  preflop: "Preflop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
};

interface ReplayControlsProps {
  frames: ReplayFrame[];
  frame: ReplayFrame;
  anchors: Array<{ street: Street; index: number }>;
  playing: boolean;
  speed: number;
  unit: AmountUnit;
  currency: string;
  revealAll: boolean;
  logOpen: boolean;
  onSeek: (index: number) => void;
  onStep: (delta: number) => void;
  onTogglePlay: () => void;
  onSpeed: (speed: number) => void;
  onUnit: (unit: AmountUnit) => void;
  onRevealAll: (revealAll: boolean) => void;
  onToggleLog: () => void;
}

export function ReplayControls({
  frames,
  frame,
  anchors,
  playing,
  speed,
  unit,
  currency,
  revealAll,
  logOpen,
  onSeek,
  onStep,
  onTogglePlay,
  onSpeed,
  onUnit,
  onRevealAll,
  onToggleLog,
}: ReplayControlsProps) {
  const last = frames.length - 1;

  return (
    <div className="replay__controls">
      <div className="replay__streets" role="group" aria-label="Jump to street">
        {anchors.map((anchor) => (
          <button
            key={anchor.street}
            type="button"
            className={`chip-btn ${frame.street === anchor.street ? "is-active" : ""}`}
            aria-pressed={frame.street === anchor.street}
            onClick={() => onSeek(anchor.index)}
          >
            {STREET_LABEL[anchor.street]}
          </button>
        ))}
      </div>

      <div className="replay__scrub-wrap">
        {/* Street boundaries drawn on the rail so scrubbing is aimed, not blind. */}
        <div className="replay__ticks" aria-hidden="true">
          {anchors.map((anchor) => (
            <span
              key={anchor.street}
              className="replay__tick"
              style={{ left: `${last > 0 ? (anchor.index / last) * 100 : 0}%` }}
            />
          ))}
        </div>
        <input
          className="replay__scrub"
          type="range"
          min={0}
          max={last}
          value={frame.index}
          aria-label="Position in hand"
          aria-valuetext={`Step ${frame.index + 1} of ${frames.length}. ${frame.description}`}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
      </div>

      <div className="replay__buttons">
        <div className="replay__transport" role="group" aria-label="Playback">
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

        <div className="replay__speed" role="group" aria-label="Playback speed">
          {SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              className={`chip-btn ${speed === value ? "is-active" : ""}`}
              aria-pressed={speed === value}
              aria-label={`${value} times speed`}
              onClick={() => onSpeed(value)}
            >
              {value}x
            </button>
          ))}
        </div>

        <div className="replay__opts">
          <div className="seg" role="group" aria-label="Show amounts in">
            <button
              type="button"
              className={`seg__btn ${unit === "chips" ? "is-active" : ""}`}
              aria-pressed={unit === "chips"}
              onClick={() => onUnit("chips")}
              title="Show stacks, bets and pot in currency"
            >
              {currency}
            </button>
            <button
              type="button"
              className={`seg__btn ${unit === "bb" ? "is-active" : ""}`}
              aria-pressed={unit === "bb"}
              onClick={() => onUnit("bb")}
              title="Show stacks, bets and pot in big blinds (B)"
            >
              BB
            </button>
          </div>

          <button
            type="button"
            className={`chip-btn ${revealAll ? "is-active" : ""}`}
            aria-pressed={revealAll}
            onClick={() => onRevealAll(!revealAll)}
            title="Reveal every card known from the history (C)"
          >
            Show all cards
          </button>

          <button
            type="button"
            className={`chip-btn replay__log-toggle ${logOpen ? "is-active" : ""}`}
            aria-pressed={logOpen}
            aria-controls="replay-log"
            onClick={onToggleLog}
          >
            Action log
          </button>
        </div>
      </div>
    </div>
  );
}
