/* tslint:disable */
/* eslint-disable */

/**
 * `anonymise(bytes)`: the shareable sample of a file, as JSON text.
 */
export function anonymise(bytes: Uint8Array): string;

/**
 * `convert(bytes, filename, optionsJson)`: one dropped file through the
 * whole pipeline; returns the `rail-convert/1` document as JSON text.
 * Throws on bad options. `optionsJson` must carry `parsedAt`.
 */
export function convert(bytes: Uint8Array, filename: string, options: string): string;

/**
 * `detect(bytes)`: decoding and the detection ranking, as JSON text.
 */
export function detect(bytes: Uint8Array): string;

/**
 * The facade's document format and the PHF schema it writes, as JSON text:
 * `{ "convert": "rail-convert/1", "phf": "phf/1" }`.
 */
export function formats(): string;

/**
 * `serialize(phfJson)`: the standard text of one PHF hand, or of an array
 * of hands (a file). Throws when the JSON is not PHF.
 */
export function serialize(phf: string): string;

/**
 * `split(bytes)`: decoding, the detection ranking, the top parser's name
 * and its split of the file into hand chunks, as JSON text (the web's
 * batched conversion, R4.1).
 */
export function split(bytes: Uint8Array): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly anonymise: (a: number, b: number) => [number, number];
    readonly convert: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly detect: (a: number, b: number) => [number, number];
    readonly formats: () => [number, number];
    readonly serialize: (a: number, b: number) => [number, number, number, number];
    readonly split: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
