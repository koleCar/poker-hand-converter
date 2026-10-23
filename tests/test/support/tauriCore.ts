/**
 * `@tauri-apps/api/core` for the desktop app's modules under Vitest
 * (`tests/vitest.config.ts` aliases it here; the harness does not install
 * the app's packages): not in the app, and `invoke` answered by the
 * handler a test sets.
 */
type Handler = (command: string, args: Record<string, unknown>) => unknown;

let handler: Handler = (command) => {
  throw new Error(`no handler for ${command}`);
};

/** Answer the app's commands in this test. */
export function setInvokeHandler(next: Handler): void {
  handler = next;
}

export function isTauri(): boolean {
  return false;
}

export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await handler(command, args)) as T;
}
