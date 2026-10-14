import type { DataSource } from "@rail/ui/data";
import { getHand } from "./hands";

/**
 * The web's implementation of the shared UI package's `DataSource`
 * (`packages/ui/data.tsx`, R2.6): the same reads the library already makes,
 * through Supabase under the reader's session. The desktop app implements the
 * same interface over Tauri commands into its local store.
 *
 * Not mounted yet: no screen on the web renders a package component that
 * fetches for itself. The shared Hands screen (R2.7 in the app, R4.5 on the
 * web) is the first; it mounts this with `DataSourceProvider`.
 */
export const webDataSource: DataSource = {
  async hand(id) {
    return (await getHand(id))?.phf ?? null;
  },
};
