/**
 * A hand in an Analysis list opens in the replayer's own window
 * (`src-tauri/src/replayer.rs`), as a row of the Hands screen does; the
 * hand's decision-by-decision grades are a link there.
 */
import { ipc } from "../../lib/ipc";

export function openInReplayer(handKey: string): void {
  ipc.replayerOpen(handKey, true).catch(() => undefined);
}
