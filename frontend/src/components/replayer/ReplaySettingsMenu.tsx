import { useEffect, useId, useRef, useState } from "react";
import type { ReplaySettings } from "./replaySettings";

interface ReplaySettingsMenuProps {
  settings: ReplaySettings;
  onChange: (patch: Partial<ReplaySettings>) => void;
}

interface ToggleSpec {
  key: keyof ReplaySettings;
  label: string;
  hint: string;
}

const TOGGLES: ToggleSpec[] = [
  {
    key: "bigBlinds",
    label: "Display chips in big blinds",
    hint: "Stacks, bets and pots in bb instead of currency (B)",
  },
  {
    key: "showKnownCards",
    label: "Show known cards",
    hint: "Reveal every card the history knows, before it was turned over (C)",
  },
  {
    key: "showHeroCards",
    label: "Show hero hole cards",
    hint: "Turn off to review the hand without seeing hero's holding",
  },
  {
    key: "anonymousNames",
    label: "Anonymous table names",
    hint: "Replace player and table names with Hero / Player 1…",
  },
];

/**
 * Gear in the replayer's top-right corner. A popover rather than a row of
 * chips: these are set-and-forget preferences, unlike the transport controls
 * under the felt which get used on every step.
 */
export function ReplaySettingsMenu({ settings, onChange }: ReplaySettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="replay__settings" ref={wrapRef}>
      <button
        type="button"
        className={`btn btn--icon ${open ? "is-active" : ""}`.trim()}
        aria-label="Replayer settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        title="Replayer settings"
        onClick={() => setOpen((current) => !current)}
      >
        ⚙
      </button>

      {open ? (
        <div className="replay__settings-panel" id={panelId} role="dialog" aria-label="Replayer settings">
          <div className="replay__settings-head">Settings</div>
          {TOGGLES.map((toggle) => (
            <label key={toggle.key} className="replay__setting" title={toggle.hint}>
              <input
                type="checkbox"
                checked={settings[toggle.key]}
                onChange={(event) => onChange({ [toggle.key]: event.target.checked })}
              />
              <span className="replay__setting-switch" aria-hidden="true" />
              <span className="replay__setting-text">{toggle.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
