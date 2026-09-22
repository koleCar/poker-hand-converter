/**
 * The app's front door: paste one hand, or upload a whole export.
 *
 * Both are on screen at once rather than behind a mode switch. They are not
 * really alternatives — one replays a hand you have in the clipboard, the other
 * converts a folder you exported from a tracker — and a person arriving with a
 * hand on their clipboard should not have to pick a mode before they can use
 * the box they came for. The paste box is open by default and first; the batch
 * drop zone sits below it, separated, for the bulk job.
 *
 * There is exactly one paste box on the page. `DropZone` used to carry its own,
 * behind a button, plus a window-level Ctrl/Cmd+V hook to make up for it being
 * hidden. With an always-open box above, both were a second target for the same
 * gesture, so they are gone.
 */

import { SingleHandPanel } from "./SingleHandPanel";
import { ConverterTab } from "../ConverterTab";
import "../../styles/upload.css";

interface UploadTabProps {
  /** Lets the shell refresh its stored-hand counter. */
  onHandsSaved?: () => void;
}

export function UploadTab({ onHandsSaved }: UploadTabProps) {
  return (
    <div className="stack">
      <SingleHandPanel onSaved={onHandsSaved} />

      <p className="upload-or">
        <span>or</span>
      </p>

      <ConverterTab onHandsSaved={onHandsSaved} />
    </div>
  );
}
