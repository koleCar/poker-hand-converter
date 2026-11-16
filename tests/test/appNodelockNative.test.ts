/**
 * The desktop app's native nodelock engine (`app/src/solver/nodelock/engine/native.ts`,
 * `docs/NODELOCK.md` §2.5): the request it sends `nodelock_solve_start` is
 * the one the app crate's command test replays
 * (`app/src-tauri/tests/fixtures/nodelock-request.json`) and the Rust parity
 * fixtures hold (`core/rail-solver/tests/fixtures/nodelock-warm.json`), all
 * written by `npm run solver:fixtures`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { nativeRequest } from "../../app/src/solver/nodelock/engine/native";
import { nativeRequestOf } from "../../app/src/solver/nodelock/engine/request";
import { decodeChunk, lockHash, lockSymmetries, NUM_COMBOS, type LockSet } from "../../web/src/lib/solver/index";
import { smallFlopSpot } from "../scripts/rail-solver/small";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const app = read("../../app/src-tauri/tests/fixtures/nodelock-request.json");
const warm = read("../../core/rail-solver/tests/fixtures/nodelock-warm.json");
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
/** As it crosses `invoke`: JSON. */
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("the native engine's request", () => {
  it("is the app crate's fixture: the reduced flop, the lock, the library chunk in base64", () => {
    const lockSet = app.request.lockSet as LockSet;
    const baseline = bytes(app.request.baseline);
    const spot = smallFlopSpot();
    const request = nativeRequestOf(lockSet, baseline, decodeChunk(baseline), { street: "flop", spot: { ...spot, symmetry: lockSymmetries(lockSet, spot.board) } }, app.request.options.maxIterations);
    expect(wire(request)).toEqual(app.request);

    // The shape `rail_solver::nodelock::NodelockRequest` reads.
    expect(Object.keys(request).sort()).toEqual(["baseline", "header", "lockSet", "options", "spot"]);
    expect(Object.keys(request.options).sort()).toEqual(["checkEvery", "checkFrom", "dcfr", "maxIterations", "targetPct"]);
    for (const range of request.spot.ranges) expect(bytes(range).length).toBe(NUM_COMBOS * 8);
    expect(Array.from(bytes(request.baseline ?? ""))).toEqual(Array.from(baseline));
    expect(JSON.parse(request.header).lockHash).toBe(lockHash(lockSet));
    expect(app.lockHash).toBe(lockHash(lockSet));
    expect(app.nextLockHash).toBe(lockHash(app.next.lockSet as LockSet));
  });

  it("is what `nativeRequest` sends for a turn lock: the deal's live turn, no baseline", async () => {
    const baseline = bytes(warm.flop[0].request.baseline);
    for (const step of warm.turn) {
      const request = await nativeRequest(step.request.lockSet as LockSet, baseline, step.request.options.maxIterations);
      expect(wire(request)).toEqual(step.request);
      expect(request.baseline).toBeNull();
    }
  });
});
