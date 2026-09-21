import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ParsedHand } from "../../lib/handParser";
import { buildReplay, streetAnchors } from "../../lib/replay";
import { formatMoney } from "../../lib/format";
import { anonymizationNote, detectAnonymization } from "../../lib/db";
import { ReplayControls, STREET_LABEL } from "./ReplayControls";
import { ReplayTable } from "./ReplayTable";
import { ShowdownStrip } from "./ShowdownStrip";
import { createAmountFormatter, effectiveStack, type AmountUnit } from "./tableMath";

interface ReplayViewerProps {
  hand: ParsedHand;
  onClose?: () => void;
  headerExtra?: React.ReactNode;
}

const UNIT_KEY = "phc.replayer.unit";
const SPEED_KEY = "phc.replayer.speed";
/** The log costs vertical space that phones do not have; start it closed. */
const WIDE_QUERY = "(min-width: 1100px)";

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

export function ReplayViewer({ hand, onClose, headerExtra }: ReplayViewerProps) {
  const frames = useMemo(() => buildReplay(hand), [hand]);
  const anchors = useMemo(() => streetAnchors(frames), [frames]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(() =>
    readStored(SPEED_KEY, (raw) => (Number.isFinite(Number(raw)) ? Number(raw) : null), 1),
  );
  const [revealAll, setRevealAll] = useState(false);
  const [unit, setUnit] = useState<AmountUnit>(() =>
    readStored<AmountUnit>(UNIT_KEY, (raw) => (raw === "bb" || raw === "chips" ? raw : null), "chips"),
  );
  const [logOpen, setLogOpen] = useState(
    () => typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches,
  );
  const currentLogRef = useRef<HTMLLIElement | null>(null);

  const format = useMemo(
    () => createAmountFormatter(unit, hand.currency, hand.bigBlind),
    [unit, hand.currency, hand.bigBlind],
  );

  // Keep the highlighted log line in view as playback advances.
  useEffect(() => {
    currentLogRef.current?.scrollIntoView({ block: "nearest" });
  }, [index, logOpen]);

  const last = frames.length - 1;
  const frame = frames[Math.min(index, last)];

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

  const changeUnit = useCallback((next: AmountUnit) => {
    setUnit(next);
    writeStored(UNIT_KEY, next);
  }, []);

  const changeSpeed = useCallback((next: number) => {
    setSpeed(next);
    writeStored(SPEED_KEY, String(next));
  }, []);

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
          changeUnit(unit === "bb" ? "chips" : "bb");
          break;
        case "c":
        case "C":
          setRevealAll((current) => !current);
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, seek, togglePlay, changeUnit, unit, last]);

  const heroProfit = hand.heroProfit;
  // Positions are resolved once by `buildReplay`; every frame carries the same
  // answer, so the first one is as good as any.
  const heroPosition = frames[0]?.seats.find((seat) => seat.isHero)?.position ?? null;

  /**
   * Rooms that do not publish real player names.
   *
   * Without this line an Ignition hand looks like a table where somebody is
   * actually called "Small Blind", which is the first thing a stranger opening
   * a shared link would get wrong about it.
   */
  const anonNote = useMemo(() => {
    const note = anonymizationNote(detectAnonymization(hand.phf));
    // The data layer's note ends with "Filter by position instead", which is
    // advice for the library's filter bar. A shared link has no filter bar,
    // so only the part that explains the seat names is kept here.
    return note ? note.replace(/\s*Filter by position instead\.?\s*$/, "") : null;
  }, [hand.phf]);

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
            <span title="Effective stack: hero against the deepest opponent">
              Eff. {format(effectiveStack(hand))}
            </span>
            {heroPosition ? <span>Hero {heroPosition}</span> : null}
            {hand.playedAt ? <span>{new Date(hand.playedAt).toLocaleString()}</span> : null}
            {heroProfit !== null ? (
              <span className={heroProfit >= 0 ? "pill pill--win" : "pill pill--loss"}>
                Hero {heroProfit >= 0 ? "+" : "-"}
                {format(Math.abs(heroProfit))}
              </span>
            ) : null}
          </div>
        </div>
        <div className="replay__header-actions">
          {headerExtra}
          {onClose ? (
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Close
            </button>
          ) : null}
        </div>
      </div>

      {anonNote ? <p className="replay__anon">{anonNote}</p> : null}

      <div className={`replay__body ${logOpen ? "" : "replay__body--solo"}`.trim()}>
        <div className="replay__stage">
          <ReplayTable hand={hand} frame={frame} revealAll={revealAll} format={format} />
          <ShowdownStrip hand={hand} frame={frame} format={format} />
        </div>

        {logOpen ? (
          <aside className="replay__log" id="replay-log" aria-label="Action log">
            <div className="replay__log-head">Action log</div>
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
                    aria-current={entry.index === frame.index ? "step" : undefined}
                    onClick={() => seek(entry.index)}
                  >
                    <span className="replay__log-street">{STREET_LABEL[entry.street]}</span>
                    <span className="replay__log-text">{entry.description}</span>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        ) : null}
      </div>

      <div className="replay__status" role="status" aria-live="polite">
        <span className="replay__status-street">{STREET_LABEL[frame.street]}</span>
        <span className="replay__status-text">{frame.description}</span>
        <span className="replay__counter" aria-hidden="true">
          {frame.index + 1} / {frames.length}
        </span>
      </div>

      <ReplayControls
        frames={frames}
        frame={frame}
        anchors={anchors}
        playing={playing}
        speed={speed}
        unit={unit}
        currency={hand.currency}
        revealAll={revealAll}
        logOpen={logOpen}
        onSeek={seek}
        onStep={step}
        onTogglePlay={togglePlay}
        onSpeed={changeSpeed}
        onUnit={changeUnit}
        onRevealAll={setRevealAll}
        onToggleLog={() => setLogOpen((current) => !current)}
      />
    </div>
  );
}
