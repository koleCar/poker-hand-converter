/**
 * The nodelocks stored on this computer (`docs/NODELOCK.md` §3), never
 * synced: the store's `nodelock*` commands (`lib/ipc.ts`), plus a signal so
 * the history and the sidebar read again after a change made here.
 *
 * A save replaces the whole row, its chunk included: re-saving a solved row
 * sends its chunk again, and a rename goes through `rename`.
 */
import { ipc, type NodeLock, type NodeLockFolder, type NodeLockInput, type NodeLockRow } from "../../lib/ipc";

export type { NodeLock, NodeLockFolder, NodeLockInput, NodeLockRow };

/** A row or a folder of My nodelocks' tree (§7.1). */
export interface NodelockItem {
  kind: "lock" | "folder";
  id: string;
}

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

  // The tree (§7.1, §7.5): folders, moves, and deletes with everything under them.
  /** Every folder. */
  folders: () => ipc.nodelockFolders(),
  /** A new folder (no id) or a rename / move of one. */
  saveFolder: async (folder: { id?: string; name: string; parent_id: string | null; sort?: number }) => {
    const saved = await ipc.nodelockFolderSave(folder);
    announce();
    return saved;
  },
  /**
   * Moves root locks and folders into `folder_id` (null: the top level),
   * before `before` (null: its top), or to its end (`atEnd`: after `last`,
   * the last item there that is not moved). False: the store refused (a
   * child lock, a folder into its own subtree).
   */
  move: async (
    items: NodelockItem[],
    to: { folder_id: string | null; before: NodelockItem | null; atEnd?: boolean; last?: NodelockItem | null },
  ) => {
    try {
      if (to.atEnd && to.last) return await ipc.nodelockMove(items, { folder_id: to.folder_id, after: to.last });
      return await ipc.nodelockMove(items, { folder_id: to.folder_id, before: to.before });
    } finally {
      announce();
    }
  },
  /** What a delete would take: the folders, the locks, and the locks built on them. */
  deletePreview: (locks: string[], folders: string[]) => ipc.nodelockDeletePreview(locks, folders),
  /** Deletes locks (with the locks built on them) and folders (with everything in them), then tells the tree. */
  removeItems: async (locks: string[], folders: string[]) => {
    try {
      if (folders.length) await ipc.nodelockFolderDelete(folders);
      if (locks.length) await ipc.nodelockDelete(locks);
    } finally {
      announce();
    }
  },
};
