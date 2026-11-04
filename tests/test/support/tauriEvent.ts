/** `@tauri-apps/api/event` for the desktop app's modules under Vitest: no events. */
export async function listen(): Promise<() => void> {
  return () => undefined;
}

export async function emit(): Promise<void> {}
