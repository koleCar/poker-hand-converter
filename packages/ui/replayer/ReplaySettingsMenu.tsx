/**
 * The gear in the replayer's header, and the sheet it opens — Tier 2.
 *
 * A sheet rather than a row of chips: these are set-and-forget preferences,
 * unlike the transport, which gets used on every step. It is the shared
 * `<Overlay>` (a modal `<dialog>`), so the focus trap, focus return and Escape
 * come from the platform; where it sits is the stylesheet's call off the
 * replayer's `data-transport` — a bottom sheet on a phone held upright, a side
 * sheet on a phone on its side, a popover under the gear on a desktop.
 *
 * Top to bottom: how the cards look (four faces, each previewed with the same
 * two cards), pot odds on or off, then the switches the keyboard shortcuts
 * also flip.
 */

import { useId } from "react";
import { PlayingCard } from "../cards/PlayingCard";
import { useUiStrings, type ReplayerStrings } from "../i18n";
import { Overlay } from "../overlay/Overlay";
import { CARD_FACES, type ReplaySettings } from "./replaySettings";
import { Icon } from "../icon/Icon";

interface ReplaySettingsMenuProps {
  settings: ReplaySettings;
  onChange: (patch: Partial<ReplaySettings>) => void;
  /** Box the sheet is placed in — the replayer's stage. */
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
] as const satisfies ReadonlyArray<keyof ReplaySettings & keyof ReplayerStrings["settings"]>;

/** The two cards every face is previewed with. */
const PREVIEW = ["9c", "4d"] as const;

export function ReplaySettingsMenu({
  settings,
  onChange,
  anchor,
  open,
  onOpenChange,
}: ReplaySettingsMenuProps) {
  const hintId = useId();
  const words = useUiStrings().replayer.settings;

  return (
    <>
      <button
        type="button"
        className={`rp__ib ${open ? "is-active" : ""}`.trim()}
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
          <span className="rp__set-label" id={`${hintId}-cards`}>
            {words.cards}
          </span>
          <div className="rp__faces" role="radiogroup" aria-labelledby={`${hintId}-cards`}>
            {CARD_FACES.map((face) => (
              <button
                key={face}
                type="button"
                role="radio"
                aria-checked={settings.cardFace === face}
                className={`rp__face ${settings.cardFace === face ? "is-on" : ""}`.trim()}
                data-cards={face}
                onClick={() => onChange({ cardFace: face })}
              >
                <span className="rp__face-pair" aria-hidden="true">
                  {PREVIEW.map((code) => (
                    <PlayingCard key={code} code={code} size="sm" />
                  ))}
                </span>
                {words.faces[face]}
              </button>
            ))}
          </div>

          <span className="rp__set-label" id={`${hintId}-odds`}>
            {words.potOdds}
          </span>
          <div
            className="rp__seg"
            role="radiogroup"
            aria-labelledby={`${hintId}-odds`}
            aria-describedby={`${hintId}-odds-hint`}
          >
            {[true, false].map((on) => (
              <button
                key={String(on)}
                type="button"
                role="radio"
                aria-checked={settings.showPotOdds === on}
                className={settings.showPotOdds === on ? "is-on" : undefined}
                onClick={() => onChange({ showPotOdds: on })}
              >
                {on ? words.show : words.hide}
              </button>
            ))}
          </div>
          <span className="rp__setting-hint rp__set-hint" id={`${hintId}-odds-hint`}>
            {words.potOddsHint}
          </span>

          <div className="rp__toggles">
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
        </div>
      </Overlay>
    </>
  );
}
