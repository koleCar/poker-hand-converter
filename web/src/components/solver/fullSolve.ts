/**
 * A full flop + turn + river solve (`npm run floplib:full`, `tests/scripts/flop-library/full.ts`),
 * read beside the library: the flop as a chunk, and one solve per flop line
 * and turn card, each holding that turn and its rivers.
 *
 * Local only: the files are hundreds of megabytes per flop, so they are not
 * in the public bucket. `NEXT_PUBLIC_FULL_SOLVE_BASE` points at them; in
 * development it defaults to `/full-solve` (`web/public/full-solve`, a
 * git-ignored link to the runner's `--out`). Without a base, or without a
 * manifest for the flop, `/solver` shows the library's flop only.
 */

import { decodeChunk, decodeSolution, type FlopChunk } from "../../lib/solver";

export interface FullTurn {
  /** The flop's betting that reaches the turn, e.g. `X-B1.82-C` (the deal's path). */
  flopPath: string;
  /** The turn card, in the solve's (canonical) suits. */
  card: string;
  /** Below the flop's directory, e.g. `turn/X-X~Kd.bin`. */
  file: string;
}

export interface FullManifest {
  iterations: number;
  exploitabilityPct: number;
  turns: FullTurn[];
}

export interface FullSolve {
  manifest: FullManifest;
  flop: FlopChunk;
  /** Loads a turn file as a chunk (the flop's header, the turn's solve). */
  turn(file: string): Promise<FlopChunk | null>;
}

export function fullSolveBase(): string | null {
  const base = process.env.NEXT_PUBLIC_FULL_SOLVE_BASE;
  if (base) return base.replace(/\/$/, "");
  return process.env.NODE_ENV === "development" ? "/full-solve" : null;
}

const solves = new Map<string, Promise<FullSolve | null>>();

/** The full solve of a (set, tree, line, canonical flop), or null when there is none. Cached. */
export function loadFullSolve(set: string, tree: string, line: string, flop: string): Promise<FullSolve | null> {
  const base = fullSolveBase();
  if (!base) return Promise.resolve(null);
  const dir = `${base}/${set}/${tree}/${line}/${flop}`;
  let pending = solves.get(dir);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(`${dir}/manifest.json`);
      if (!res.ok) return null;
      const manifest = (await res.json()) as FullManifest;
      const flopRes = await fetch(`${dir}/flop.bin`);
      if (!flopRes.ok) return null;
      const chunk = decodeChunk(await flopRes.arrayBuffer());
      const turns = new Map<string, Promise<FlopChunk | null>>();
      return {
        manifest,
        flop: chunk,
        turn: (file: string) => {
          let turn = turns.get(file);
          if (!turn) {
            turn = fetch(`${dir}/${file}`)
              .then(async (r) => (r.ok ? { header: chunk.header, result: decodeSolution(await r.arrayBuffer()) } : null))
              .catch(() => null);
            turns.set(file, turn);
          }
          return turn;
        },
      };
    })().catch(() => null);
    solves.set(dir, pending);
  }
  return pending;
}
