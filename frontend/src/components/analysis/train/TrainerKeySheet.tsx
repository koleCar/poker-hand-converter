/**
 * The trainer's keyboard map, on `?` or the Keys button — the replayer's
 * shortcut sheet pattern (`replayer/ShortcutSheet.tsx`), printing
 * `TRAINER_SHORTCUTS` beside the hook that implements it.
 */

"use client";

import { useDict } from "../../../lib/i18n/client";
import { Overlay } from "../../ui/Overlay";
import { TRAINER_SHORTCUTS } from "./trainerKeys";

export function TrainerKeySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useDict().analysis.train.keys;
  return (
    <Overlay open={open} onClose={onClose} title={t.title} note={t.note} className="rp-ov rp-ov--keys">
      <dl className="rp__facts rp__keys">
        {TRAINER_SHORTCUTS.map((shortcut) => (
          <div className="rp__fact" key={shortcut.id}>
            <dt>
              {shortcut.keys.map((key) => (
                <kbd className="rp__key" key={key}>
                  {key}
                </kbd>
              ))}
            </dt>
            <dd>{t.items[shortcut.id]}</dd>
          </div>
        ))}
      </dl>
    </Overlay>
  );
}
