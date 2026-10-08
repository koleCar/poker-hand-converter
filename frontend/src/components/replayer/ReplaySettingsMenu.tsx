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
import { useDict } from "../../lib/i18n/client";
import type { Dict } from "../../lib/i18n/types";
import { Overlay } from "../ui/Overlay";
import type { ReplaySettings } from "./replaySettings";
import { Icon } from "../ui/Icon";

interface ReplaySettingsMenuProps {
  settings: ReplaySettings;
  onChange: (patch: Partial<ReplaySettings>) => void;
  /** Box the sheet should cover — the replayer's stage. */
  anchor: React.RefObject<HTMLElement | null>;
  /** Lifted so the viewer's key handler knows an overlay owns the keyboard. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Each toggle's label and hint in `replayer.settings`: `key` and `${key}Hint`. */
const TOGGLES = [
  "bigBlinds",
  "showKnownCards",
  "showHeroCards",
  "anonymousNames",
] as const satisfies ReadonlyArray<keyof ReplaySettings & keyof Dict["replayer"]["settings"]>;

export function ReplaySettingsMenu({
  settings,
  onChange,
  anchor,
  open,
  onOpenChange,
}: ReplaySettingsMenuProps) {
  const hintId = useId();
  const en = useDict();
  const words = en.replayer.settings;

  return (
    <>
      <button
        type="button"
        className={`btn btn--icon ${open ? "is-active" : ""}`.trim()}
        aria-label={words.open}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={words.open}
        onClick={() => onOpenChange(!open)}
      >
        <Icon name="settings" />
      </button>

      <Overlay
        open={open}
        onClose={() => onOpenChange(false)}
        title={words.title}
        anchor={anchor}
        className="rp-ov rp-ov--settings"
      >
        <div className="rp__settings-list">
          {TOGGLES.map((key) => (
            <label key={key} className="rp__setting">
              <input
                type="checkbox"
                checked={settings[key]}
                aria-describedby={`${hintId}-${key}`}
                onChange={(event) => onChange({ [key]: event.target.checked })}
              />
              <span className="rp__setting-switch" aria-hidden="true" />
              <span className="rp__setting-text">
                {words[key]}
                {/* Spelled out rather than hidden in a `title`: a tooltip is
                    unreachable by keyboard and by touch. */}
                <span className="rp__setting-hint" id={`${hintId}-${key}`}>
                  {words[`${key}Hint`]}
                </span>
              </span>
            </label>
          ))}
        </div>
      </Overlay>
    </>
  );
}
