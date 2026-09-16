import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ParsedHand, Street } from "../../lib/handParser";
import { buildReplay, streetAnchors } from "../../lib/replay";
import { formatMoney } from "../../lib/format";
import { ReplayTable } from "./ReplayTable";

interface ReplayViewerProps {
  hand: ParsedHand;
  onClose?: () => void;
  headerExtra?: React.ReactNode;
}

const SPEEDS = [0.5, 1, 1.5, 2, 4];

const STREET_LABEL: Record<Street, string> = {
  preflop: "Preflop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
};

export function ReplayViewer({ hand, onClose, headerExtra }: ReplayViewerProps) {
  const frames = useMemo(() => buildReplay(hand), [hand]);
  const anchors = useMemo(() => streetAnchors(frames), [frames]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [revealAll, setRevealAll] = useState(false);
  const currentLogRef = useRef<HTMLLIElement | null>(null);

  // Keep the highlighted log line in view as playback advances.
  useEffect(() => {
    currentLogRef.current?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const last = frames.length - 1;
  const frame = frames[Math.min(index, last)];

  const step = useCallback(
    (delta: number) => {
      setIndex((current) => Math.max(0, Math.min(last, current + delta)));
    },
    [last],
  );

  useEffect(() => {
    if (!playing || index >= last) {
      return;
    }
    const hold = Math.max(120, frames[index].holdMs / speed);
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
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setPlaying(false);
        step(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setPlaying(false);
        step(-1);
      } else if (event.key === " ") {
        event.preventDefault();
        setPlaying((current) => !current);
      } else if (event.key === "Home") {
        setIndex(0);
      } else if (event.key === "End") {
        setIndex(last);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, last]);

  function togglePlay() {
    if (index >= last) {
      setIndex(0);
      setPlaying(true);
      return;
    }
    setPlaying((current) => !current);
  }

  const heroProfit = hand.heroProfit;

  return (
    <div className="replay">
      <div className="replay__header">
        <div className="replay__title">
          <h3>
            Hand #{hand.handId}
            {hand.tableName ? <span className="replay__table">{hand.tableName}</span> : null}
          </h3>
          <div className="replay__meta">
            <span>{hand.gameLabel}</span>
            <span>
              {formatMoney(hand.currency, hand.smallBlind)}/
              {formatMoney(hand.currency, hand.bigBlind)}
            </span>
            <span>{hand.seats.length} players</span>
            {hand.playedAt ? (
              <span>{new Date(hand.playedAt).toLocaleString("hr-HR")}</span>
            ) : null}
            {heroProfit !== null ? (
              <span className={heroProfit >= 0 ? "pill pill--win" : "pill pill--loss"}>
                Hero {heroProfit >= 0 ? "+" : "-"}
                {formatMoney(hand.currency, Math.abs(heroProfit))}
              </span>
            ) : null}
          </div>
        </div>
        <div className="replay__header-actions">
          {headerExtra}
          {onClose ? (
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Zatvori
            </button>
          ) : null}
        </div>
      </div>

      <div className="replay__body">
        <ReplayTable hand={hand} frame={frame} revealAll={revealAll} />

        <aside className="replay__log">
          <div className="replay__log-head">Tijek ruke</div>
          <ol className="replay__log-list">
            {frames.map((entry) => (
              <li
                key={entry.index}
                ref={entry.index === frame.index ? currentLogRef : undefined}
                className={[
                  "replay__log-item",
                  `replay__log-item--${entry.kind}`,
                  entry.index === frame.index ? "is-current" : "",
                  entry.index < frame.index ? "is-past" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <button
                  type="button"
                  onClick={() => {
                    setPlaying(false);
                    setIndex(entry.index);
                  }}
                >
                  <span className="replay__log-street">{STREET_LABEL[entry.street]}</span>
                  <span className="replay__log-text">{entry.description}</span>
                </button>
              </li>
            ))}
          </ol>
        </aside>
      </div>

      <div className="replay__status">{frame.description}</div>

      <div className="replay__controls">
        <div className="replay__streets">
          {anchors.map((anchor) => (
            <button
              key={anchor.street}
              type="button"
              className={`chip-btn ${frame.street === anchor.street ? "is-active" : ""}`}
              onClick={() => {
                setPlaying(false);
                setIndex(anchor.index);
              }}
            >
              {STREET_LABEL[anchor.street]}
            </button>
          ))}
        </div>

        <input
          className="replay__scrub"
          type="range"
          min={0}
          max={last}
          value={frame.index}
          onChange={(event) => {
            setPlaying(false);
            setIndex(Number(event.target.value));
          }}
          aria-label="Pozicija u ruci"
        />

        <div className="replay__buttons">
          <button type="button" className="btn btn--icon" onClick={() => setIndex(0)} title="Početak (Home)">
            ⏮
          </button>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => {
              setPlaying(false);
              step(-1);
            }}
            title="Nazad (←)"
          >
            ◀
          </button>
          <button type="button" className="btn btn--play" onClick={togglePlay} title="Play/pause (space)">
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => {
              setPlaying(false);
              step(1);
            }}
            title="Naprijed (→)"
          >
            ▶
          </button>
          <button type="button" className="btn btn--icon" onClick={() => setIndex(last)} title="Kraj (End)">
            ⏭
          </button>

          <div className="replay__speed">
            {SPEEDS.map((value) => (
              <button
                key={value}
                type="button"
                className={`chip-btn ${speed === value ? "is-active" : ""}`}
                onClick={() => setSpeed(value)}
              >
                {value}x
              </button>
            ))}
          </div>

          <label className="replay__toggle">
            <input
              type="checkbox"
              checked={revealAll}
              onChange={(event) => setRevealAll(event.target.checked)}
            />
            Prikaži sve poznate karte
          </label>

          <span className="replay__counter">
            {frame.index + 1} / {frames.length}
          </span>
        </div>
      </div>
    </div>
  );
}
