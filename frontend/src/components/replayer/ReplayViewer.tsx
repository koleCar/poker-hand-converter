import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ParsedHand } from "../../lib/handParser";
import { buildReplay, streetAnchors } from "../../lib/replay";
import { formatMoney } from "../../lib/format";
import { ReplayControls } from "./ReplayControls";
import { ReplaySettingsMenu } from "./ReplaySettingsMenu";
import { ReplayTable } from "./ReplayTable";
import { ShowdownStrip } from "./ShowdownStrip";
import {
  createNameMask,
  loadReplaySettings,
  saveReplaySettings,
  unitOf,
  type ReplaySettings,
} from "./replaySettings";
import { createAmountFormatter } from "./tableMath";

interface ReplayViewerProps {
  hand: ParsedHand;
  /** Room the hand was played in; the header's first crumb when known. */
  site?: string | null;
  onClose?: () => void;
  /** Rendered first in the header's icon row — the share button in practice. */
  headerExtra?: React.ReactNode;
}

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

export function ReplayViewer({ hand, site, onClose, headerExtra }: ReplayViewerProps) {
  const frames = useMemo(() => buildReplay(hand), [hand]);
  const anchors = useMemo(() => streetAnchors(frames), [frames]);
  // Street markers are already the chips above the scrubber and the board on
  // the felt; in the log they were three-quarters noise.
  const logFrames = useMemo(() => frames.filter((entry) => entry.kind !== "street"), [frames]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(() =>
    readStored(SPEED_KEY, (raw) => (Number.isFinite(Number(raw)) ? Number(raw) : null), 1),
  );
  const [settings, setSettings] = useState<ReplaySettings>(loadReplaySettings);
  const [logOpen, setLogOpen] = useState(
    () => typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches,
  );
  const logListRef = useRef<HTMLOListElement | null>(null);
  const currentLogRef = useRef<HTMLLIElement | null>(null);

  const format = useMemo(
    () => createAmountFormatter(unitOf(settings), hand.currency, hand.bigBlind),
    [settings, hand.currency, hand.bigBlind],
  );
  const mask = useMemo(
    () => createNameMask(hand, settings.anonymousNames),
    [hand, settings.anonymousNames],
  );

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

  // Keep the highlighted log line in view — by scrolling the log box itself,
  // never `scrollIntoView`, which also drags the page around every time the
  // viewer steps to the next action.
  useEffect(() => {
    const list = logListRef.current;
    const item = currentLogRef.current;
    if (!list || !item) {
      return;
    }
    const top = item.offsetTop - list.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [activeLogIndex, logOpen]);

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
    <div className="replay">
      {/* Everything the header used to carry besides these three — hand id,
          game, seat count, effective stack, hero position, date and result —
          is either already on the felt or is a spoiler. */}
      <div className="replay__header">
        <div className="replay__meta">
          {site ? <span>{site}</span> : null}
          {mask.tableName ? <span>{mask.tableName}</span> : null}
          <span>
            {formatMoney(hand.currency, hand.smallBlind)}/
            {formatMoney(hand.currency, hand.bigBlind)}
          </span>
        </div>
        <div className="replay__header-actions">
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

      <div className={`replay__body ${logOpen ? "" : "replay__body--solo"}`.trim()}>
        <div className="replay__stage">
          <ReplayTable hand={hand} frame={frame} settings={settings} mask={mask} format={format} />
          <ShowdownStrip hand={hand} frame={frame} settings={settings} mask={mask} format={format} />
        </div>

        {logOpen ? (
          <aside className="replay__log" id="replay-log" aria-label="Action log">
            {/* Taken out of flow by the stylesheet so a long hand cannot make
                this column taller than the table it sits next to. */}
            <div className="replay__log-inner">
              <div className="replay__log-head">Action log</div>
              <ol className="replay__log-list" ref={logListRef}>
                {logFrames.map((entry) => (
                  <li
                    key={entry.index}
                    ref={entry.index === activeLogIndex ? currentLogRef : undefined}
                    className={[
                      "replay__log-item",
                      `replay__log-item--${entry.kind}`,
                      entry.index === activeLogIndex ? "is-current" : "",
                      entry.index < activeLogIndex ? "is-past" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <button
                      type="button"
                      aria-current={entry.index === activeLogIndex ? "step" : undefined}
                      onClick={() => seek(entry.index)}
                    >
                      <span className="replay__log-text">{mask.text(entry.description)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          </aside>
        ) : null}
      </div>

      <ReplayControls
        frames={frames}
        frame={frame}
        anchors={anchors}
        playing={playing}
        speed={speed}
        logOpen={logOpen}
        onSeek={seek}
        onStep={step}
        onTogglePlay={togglePlay}
        onSpeed={changeSpeed}
        onToggleLog={() => setLogOpen((current) => !current)}
      />
    </div>
  );
}
