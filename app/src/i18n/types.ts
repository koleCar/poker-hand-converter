import type { en } from "./en";

/** `en`'s shape with every literal widened: what another language fills. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => string
    ? (...args: A) => string
    : { readonly [K in keyof T]: Widen<T[K]> };

export type Dict = Widen<typeof en>;

export type Locale = "en" | "hr";

/**
 * English is the default and, for now, the only language shown: Croatian
 * keys are prepared (`hr.ts`) but there is no language setting yet.
 */
export const DEFAULT_LOCALE: Locale = "en";
