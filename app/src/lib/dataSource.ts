/**
 * The shared UI package's `DataSource` (`packages/ui/data.tsx`) over the Tauri
 * commands into the local store: what `useHand(id)` reads when the Hands
 * screen opens a hand in the replayer (R2.7a). An id is a `hand_key`.
 */
import type { DataSource } from "@rail/ui/data";
import type { PhfHand } from "@rail/ui/model/phf";

import { ipc } from "./ipc";

/** The last few hands parsed: stepping back and forth through the list reuses them. */
const RECENT = 16;
const recent = new Map<string, PhfHand>();

export const storeDataSource: DataSource = {
  async hand(id: string): Promise<PhfHand | null> {
    const cached = recent.get(id);
    if (cached) {
      return cached;
    }
    const json = await ipc.handPhf(id);
    if (json === null) {
      return null;
    }
    const hand = JSON.parse(json) as PhfHand;
    recent.set(id, hand);
    if (recent.size > RECENT) {
      const oldest = recent.keys().next().value;
      if (oldest !== undefined) {
        recent.delete(oldest);
      }
    }
    return hand;
  },
};
