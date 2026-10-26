/**
 * What the desktop app's modules touch of the webview when they load
 * (`app/src/lib/appearance.ts`: the system's light or dark, the copy of the
 * appearance, the root element's attributes), for rendering its screens in
 * Node. Import it before any app module.
 */
const root = { setAttribute: () => undefined };
const globals = globalThis as unknown as Record<string, unknown>;
globals.window ??= {
  matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
  localStorage: { getItem: () => null, setItem: () => undefined },
  location: { hash: "" },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
globals.document ??= { documentElement: root };

export {};
