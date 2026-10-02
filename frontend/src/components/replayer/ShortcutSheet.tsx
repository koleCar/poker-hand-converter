/**
 * The keyboard map, on `?` — Tier 2.
 *
 * The table itself lives in `shortcuts.ts`, beside the handler that implements
 * it, so this file is only the rendering of it.
 */

import { useDict } from "../../lib/i18n/client";
import { Overlay } from "../ui/Overlay";
import { SHORTCUTS, SPACE_KEY } from "./shortcuts";

interface ShortcutSheetProps {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
}

export function ShortcutSheet({ open, onClose, anchor }: ShortcutSheetProps) {
  const en = useDict();
  return (
    <Overlay
      open={open}
      onClose={onClose}
      title={en.replayer.keys.title}
      note={en.replayer.keys.note}
      anchor={anchor}
      className="rp-ov rp-ov--keys"
    >
      <dl className="rp__facts rp__keys">
        {SHORTCUTS.map((shortcut) => (
          <div className="rp__fact" key={shortcut.id}>
            <dt>
              {shortcut.keys.map((key) => (
                <kbd className="rp__key" key={key}>
                  {key === SPACE_KEY ? en.replayer.keys.space : key}
                </kbd>
              ))}
            </dt>
            <dd>{en.replayer.keys.items[shortcut.id]}</dd>
          </div>
        ))}
      </dl>
    </Overlay>
  );
}
