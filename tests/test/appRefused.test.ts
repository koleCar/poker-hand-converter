/**
 * The desktop app's Refused hands screen (R1.6): its pages - which page
 * buttons it shows, and that a page is asked of the store by offset and
 * limit (`quarantine_entries`, paged in `rail_store::Reader::quarantine_page`,
 * tested there).
 */

import "./support/appWindow";

import { describe, expect, it } from "vitest";

import { ipc } from "../../app/src/lib/ipc";
import { PAGE_SIZE, pageList } from "../../app/src/screens/Refused";
import { setInvokeHandler } from "./support/tauriCore";

describe("desktop Refused hands, paged", () => {
  it("shows every page when there are few, else the ends and the current page's neighbours", () => {
    expect(PAGE_SIZE).toBe(50);
    expect(pageList(0, 1)).toEqual([0]);
    expect(pageList(2, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(pageList(0, 20)).toEqual([0, 1, null, 19]);
    expect(pageList(9, 20)).toEqual([0, null, 8, 9, 10, null, 19]);
    expect(pageList(19, 20)).toEqual([0, null, 18, 19]);
    expect(pageList(2, 20)).toEqual([0, 1, 2, 3, null, 19]);
  });

  it("asks the store for one page by offset and limit, and without one for the default", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    setInvokeHandler((command, args) => {
      calls.push([command, args]);
      return { entries: [], truncated: false, total: 0 };
    });
    await ipc.quarantineEntries(7, "shape", { offset: 100, limit: 50 });
    await ipc.quarantineEntries(null, null);
    expect(calls).toEqual([
      ["quarantine_entries", { sourceId: 7, reason: "shape", offset: 100, limit: 50 }],
      ["quarantine_entries", { sourceId: null, reason: null, offset: null, limit: null }],
    ]);
  });
});
