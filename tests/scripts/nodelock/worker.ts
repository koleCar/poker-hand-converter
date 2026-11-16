/**
 * One part of a split flop solve in a Node worker thread (`bench.ts`): the
 * same `SplitPart` the app's nodelock workers hold.
 */
import { parentPort } from "node:worker_threads";

import { SplitPart, type SplitSpec, type SplitStep } from "../../../web/src/lib/solver/index.js";

type Request = { type: "part"; id: number; spec: SplitSpec; cards: number[] } | { type: "traverse"; id: number; step: SplitStep };

let part: SplitPart | null = null;

parentPort?.on("message", (message: Request) => {
  if (message.type === "part") {
    part = new SplitPart(message.spec, message.cards);
    parentPort?.postMessage({ id: message.id, bytes: part.bytes, valueSum: part.valueSum });
    return;
  }
  if (!part) throw new Error("no part");
  const values = part.traverse(message.step);
  parentPort?.postMessage({ id: message.id, values }, [values.values.buffer, values.units.buffer, values.edges.buffer]);
});
