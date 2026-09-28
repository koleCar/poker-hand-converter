/**
 * The keyboard map, on `?` — Tier 2.
 *
 * The table itself lives in `shortcuts.ts`, beside the handler that implements
 * it, so this file is only the rendering of it.
 */

import { Overlay } from "../ui/Overlay";
import { SHORTCUTS } from "./shortcuts";

interface ShortcutSheetProps {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
}

export function ShortcutSheet({ open, onClose, anchor }: ShortcutSheetProps) {
  return (
    <Overlay
      open={open}
      onClose={onClose}
      title="Keyboard"
      note="Keys work while the replayer has focus"
      anchor={anchor}
      className="rp-ov rp-ov--keys"
    >
      <dl className="rp__facts rp__keys">
        {SHORTCUTS.map((shortcut) => (
          <div className="rp__fact" key={shortcut.description}>
            <dt>
              {shortcut.keys.map((key) => (
                <kbd className="rp__key" key={key}>
                  {key}
                </kbd>
              ))}
            </dt>
            <dd>{shortcut.description}</dd>
          </div>
        ))}
      </dl>
    </Overlay>
  );
}
