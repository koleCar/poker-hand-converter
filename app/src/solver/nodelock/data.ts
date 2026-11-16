/**
 * The nodelocks stored on this computer (`docs/NODELOCK.md` §3), never
 * synced: the store's `nodelock*` commands (`lib/ipc.ts`), plus a signal so
 * the history and the sidebar read again after a change made here.
 *
 * A save replaces the whole row, its chunk included: re-saving a solved row
 * sends its chunk again, and a rename goes through `rename`.
 */
import { ipc, type NodeLock, type NodeLockInput, type NodeLockRow } from "../../lib/ipc";

export type { NodeLock, NodeLockInput, NodeLockRow };

let changed = new Set<() => void>();

/** Hears every save, rename and delete made here. */
export function onNodelocksChanged(listener: () => void): () => void {
  changed.add(listener);
  return () => {
    changed.delete(listener);
  };
}

function announce() {
  const listeners = changed;
  changed = new Set(listeners);
  for (const listener of listeners) listener();
}

export const nodelockData = {
  /** Every nodelock, newest change first, without the chunk. */
  list: () => ipc.nodelockList(),
  /** One nodelock with its chunk, or null. */
  get: (id: string) => ipc.nodelockGet(id),
  /** Insert (no id) or replace a row, with its chunk; the row's id back. */
  save: async (row: NodeLockInput, result: Uint8Array | null = null) => {
    const saved = await ipc.nodelockSave(row, result);
    announce();
    return saved.id;
  },
  rename: async (id: string, name: string) => {
    await ipc.nodelockRename(id, name);
    announce();
  },
  remove: async (ids: string[]) => {
    await ipc.nodelockDelete(ids);
    announce();
  },
};
