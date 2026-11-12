/**
 * The Solver library's host in the app: the dictionary of the app's
 * language, and a flop library reader whose files come through Rust
 * (`flop_library_file`: the disk cache, else the web's public bucket), the
 * same files the analysis worker reads. Full solves are the web's local
 * development aid; the app serves none, so a turn is always solved live.
 */
import { useMemo } from "react";

import { fetchOutcomeOfError } from "../analysis/workerClient";
import { useLocale } from "../i18n";
import { errorText, inApp, ipc } from "../lib/ipc";
import { FlopLibraryLoader, solverEn, solverHr, type LibraryFetch, type SolverDict, type SolverHost } from "./door";

/** The loader's base: any prefix works, Rust is asked for the path after it (as in `analysis/worker.ts`). */
const BASE = "rail-flop-library:";

const fetcher: LibraryFetch = async (url) => {
  const path = url.startsWith(`${BASE}/`) ? url.slice(BASE.length + 1) : url;
  try {
    const bytes = await ipc.flopLibraryFile(path);
    return {
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(bytes),
      json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)) as unknown),
    };
  } catch (error) {
    const outcome = fetchOutcomeOfError(errorText(error));
    if (outcome.kind === "offline") throw new Error("offline", { cause: error });
    const status = outcome.kind === "absent" ? 404 : outcome.kind === "transient" ? outcome.status : 503;
    const fail = () => Promise.reject(new Error(outcome.kind));
    return { ok: false, status, arrayBuffer: fail, json: fail };
  }
};

let loader: FlopLibraryLoader | null = null;

/** One reader for the window's life: a chunk fetched for the Solver tab is there for a hand's analysis too. */
function libraryLoader(): FlopLibraryLoader {
  loader ??= new FlopLibraryLoader(BASE, fetcher);
  return loader;
}

export function useSolverHost(): SolverHost {
  const locale = useLocale();
  return useMemo(() => {
    const t: SolverDict = locale === "hr" ? solverHr : solverEn;
    // Outside the app (a browser) there is no Rust to read the files: the library says it is unavailable.
    return { t, loader: inApp ? libraryLoader() : null, fullSolveBase: null };
  }, [locale]);
}
