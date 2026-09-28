/**
 * Gear in the replayer's top-right corner — Tier 2.
 *
 * A sheet rather than a row of chips: these are set-and-forget preferences,
 * unlike the transport controls under the felt which get used on every step.
 *
 * It used to be a bare `<div>` popover held open by a `mousedown` listener on
 * `document`, with no focus trap, no focus return and a background that was
 * still tabbable. It is the shared `<Overlay>` now, which is a modal
 * `<dialog>`, so all three come from the platform.
 */

import { useId } from "react";
import { Overlay } from "../ui/Overlay";
import type { ReplaySettings } from "./replaySettings";

interface ReplaySettingsMenuProps {
  settings: ReplaySettings;
  onChange: (patch: Partial<ReplaySettings>) => void;
  /** Box the sheet should cover — the replayer's stage. */
  anchor: React.RefObject<HTMLElement | null>;
  /** Lifted so the viewer's key handler knows an overlay owns the keyboard. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
    hint: "Turn off to review the hand without seeing hero's holding (H)",
  },
  {
    key: "anonymousNames",
    label: "Anonymous table names",
    hint: "Replace player and table names with Hero / Player 1…",
  },
];

export function ReplaySettingsMenu({
  settings,
  onChange,
  anchor,
  open,
  onOpenChange,
}: ReplaySettingsMenuProps) {
  const hintId = useId();

  return (
    <>
      <button
        type="button"
        className={`btn btn--icon ${open ? "is-active" : ""}`.trim()}
        aria-label="Replayer settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Replayer settings"
        onClick={() => onOpenChange(!open)}
      >
        ⚙
      </button>

      <Overlay
        open={open}
        onClose={() => onOpenChange(false)}
        title="Settings"
        anchor={anchor}
        className="rp-ov rp-ov--settings"
      >
        <div className="rp__settings-list">
          {TOGGLES.map((toggle) => (
            <label key={toggle.key} className="rp__setting">
              <input
                type="checkbox"
                checked={settings[toggle.key]}
                aria-describedby={`${hintId}-${toggle.key}`}
                onChange={(event) => onChange({ [toggle.key]: event.target.checked })}
              />
              <span className="rp__setting-switch" aria-hidden="true" />
              <span className="rp__setting-text">
                {toggle.label}
                {/* Spelled out rather than hidden in a `title`: a tooltip is
                    unreachable by keyboard and by touch. */}
                <span className="rp__setting-hint" id={`${hintId}-${toggle.key}`}>
                  {toggle.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </Overlay>
    </>
  );
}
