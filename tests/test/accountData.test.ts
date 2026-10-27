/**
 * Your data on the web (Rail R6.5, `web/src/lib/account/`,
 * `components/account/`):
 *
 * - the streaming ZIP writer: deflated and stored entries read back by the
 *   converter's own reader (`zipStream.ts`) with their CRC-32, UTF-8 names,
 *   and an archive past 65 535 entries (zip64 end records);
 * - the export over a fake source: hands a page a file with their derived
 *   rows beside them, every inventory section paged into one file, the
 *   original files stored as they are, README and manifest; cancel; a
 *   network blip retried, the daily budget not;
 * - the deletion loop: the username on the first call only, "in progress"
 *   called again, a refusal returned as it is;
 * - the panels' words in English and Croatian.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { readZipDirectory, readZipEntry } from "../../web/src/components/converter/zipStream.js";
import { exportAccount, ExportCancelled, exportFileName } from "../../web/src/lib/account/export.js";
import { buildReadme } from "../../web/src/lib/account/readme.js";
import { runAccountDeletion } from "../../web/src/lib/account/deletion.js";
import { BlobSink, crc32, ZipWriter, type ZipSink } from "../../web/src/lib/account/zipWriter.js";
import type {
  Cursor,
  DeleteCallResult,
  ExportManifest,
  ExportSource,
  HandsPage,
  RowsPage,
} from "../../web/src/lib/db/accountData.js";
import { ExportProgressView, formatSize, YourDataPanel } from "../../web/src/components/account/YourDataPanel.js";
import { AccountDeletedNotice, DeletionExplainer } from "../../web/src/components/account/DeleteAccountPanel.js";
import { I18nProvider } from "../../web/src/lib/i18n/client.js";
import { en } from "../../web/src/lib/i18n/en.js";
import { hr } from "../../web/src/lib/i18n/hr.js";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function readAll(blob: Blob): Promise<Map<string, string>> {
  const directory = await readZipDirectory(blob);
  if (!("entries" in directory)) throw new Error(`not a zip: ${directory.problem}`);
  const out = new Map<string, string>();
  for (const entry of directory.entries) {
    const bytes = await readZipEntry(blob, entry, 64 * 1024 * 1024);
    expect(crc32(bytes), `${entry.name}: CRC-32 as declared`).toBe(entry.crc32);
    out.set(entry.name, text(bytes));
  }
  return out;
}

describe("ZipWriter", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const a = new TextEncoder().encode("1234");
    const b = new TextEncoder().encode("56789");
    expect(crc32(b, crc32(a))).toBe(0xcbf43926);
  });

  it("writes deflated and stored entries the converter's reader opens, names in UTF-8", async () => {
    const sink = new BlobSink();
    const zip = new ZipWriter(sink, () => new Date(2026, 9, 26, 14, 30, 10));
    const big = "{\"hand\":1}\n".repeat(50_000);
    await zip.addEntry("README.md", "# Your Rail data\n");
    const entry = await zip.openEntry("hands/hands-00001.ndjson");
    await entry.write(big.slice(0, 200_000));
    await entry.write(new TextEncoder().encode(big.slice(200_000)));
    await entry.close();
    await zip.addEntry("originals/Ruka čćž.txt.gz", new Uint8Array([31, 139, 8, 0, 1, 2, 3]), { compress: false });
    const done = await zip.finish();
    const blob = sink.toBlob();
    expect(done.bytes).toBe(blob.size);
    expect(done.entries).toBe(3);
    expect(blob.size).toBeLessThan(big.length / 20); // deflated

    const files = await readAll(blob);
    expect([...files.keys()]).toEqual(["README.md", "hands/hands-00001.ndjson", "originals/Ruka čćž.txt.gz"]);
    expect(files.get("hands/hands-00001.ndjson")).toBe(big);
    const directory = await readZipDirectory(blob);
    if (!("entries" in directory)) throw new Error("not a zip");
    expect(directory.entries.map((e) => e.method)).toEqual([8, 8, 0]);
  });

  it("refuses a second open entry, and writing after the end", async () => {
    const zip = new ZipWriter(new BlobSink());
    const first = await zip.openEntry("a.txt");
    await expect(zip.openEntry("b.txt")).rejects.toThrow();
    await first.close();
    await zip.finish();
    await expect(zip.openEntry("c.txt")).rejects.toThrow();
  });

  it("past 65 535 entries ends with the zip64 records, and is read back", async () => {
    const sink = new BlobSink();
    const zip = new ZipWriter(sink);
    const n = 70_000;
    for (let i = 0; i < n; i++) {
      await zip.addEntry(`f/${i}`, "", { compress: false });
    }
    await zip.finish();
    const blob = sink.toBlob();
    const directory = await readZipDirectory(blob);
    if (!("entries" in directory)) throw new Error("not a zip");
    expect(directory.entries.length).toBe(n);
    expect(directory.entries[n - 1].name).toBe(`f/${n - 1}`);
    const tail = new Uint8Array(await blob.slice(blob.size - 98).arrayBuffer());
    const view = new DataView(tail.buffer);
    expect(view.getUint32(0, true)).toBe(0x06064b50); // zip64 end of central directory
    expect(view.getUint32(56, true)).toBe(0x07064b50); // its locator
    expect(view.getUint16(76 + 8, true)).toBe(0xffff); // the classic record defers to it
  });

  it("a sink that fails rejects the write instead of hanging", async () => {
    let writes = 0;
    const failing: ZipSink = {
      write: () => (++writes > 1 ? Promise.reject(new Error("disk full")) : Promise.resolve()),
      close: () => Promise.resolve(),
    };
    const zip = new ZipWriter(failing);
    const entry = await zip.openEntry("x.ndjson");
    const payload = "x".repeat(1_000_000);
    await expect(
      (async () => {
        for (let i = 0; i < 20; i++) await entry.write(payload + i);
        await entry.close();
      })(),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

const INVENTORY: ExportManifest["inventory"] = [
  { name: "public.hands", export: "file", file: "hands/hands-NNNN.ndjson", reader: "hands", section: "hands", onDelete: "erase", note: "Every stored hand." },
  { name: "public.hand_stats", export: "file", file: "hand_stats/hand_stats-NNNN.ndjson", reader: "hands", section: "hand_stats", onDelete: "cascade", note: "Stats." },
  { name: "public.decision_analysis", export: "file", file: "analysis/decision_analysis-NNNN.ndjson", reader: "hands", section: "decision_analysis", onDelete: "cascade", note: "Decisions." },
  { name: "public.player_notes", export: "file", file: "player_notes.ndjson", reader: "rows", section: "player_notes", onDelete: "cascade", note: "Notes." },
  { name: "public.posts", export: "file", file: "forum/posts.ndjson", reader: "sealed", section: "posts", onDelete: "anonymise", note: "Posts." },
  { name: "public.saved_posts", export: "file", file: "forum/saved_posts.ndjson", reader: "rows", section: "saved_posts", onDelete: "cascade", note: "Saved." },
  { name: "public.profiles", export: "profile", file: null, reader: "profile", section: null, onDelete: "cascade", note: "Profile." },
  { name: "public.hero_rollups", export: "derived", file: null, reader: null, section: null, onDelete: "cascade", note: "Summary of hand_stats." },
  { name: "public.moderation_actions", export: "on_request", file: null, reader: null, section: null, onDelete: "retain", note: "The log." },
  { name: "storage.hand-uploads", export: "file", file: "originals/<path>", reader: "storage", section: "hand_uploads", onDelete: "erase", note: "Originals." },
];

const ACCOUNT = "00000000-0000-0000-0000-00000000e001";

function fakeSource(options: { hands: number; notes: number; failOnce?: string[]; budgetGone?: boolean } = { hands: 5, notes: 7 }) {
  const calls: string[] = [];
  const failOnce = new Set(options.failOnce ?? []);
  const hands = Array.from({ length: options.hands }, (_, i) => ({ id: `h${String(i).padStart(4, "0")}`, phf: { schema: "phf/1", i } }));
  const notes = Array.from({ length: options.notes }, (_, i) => ({ owner_id: ACCOUNT, site: "pokerstars", player: `p${i}` }));
  const maybeFail = (key: string) => {
    if (failOnce.has(key)) {
      failOnce.delete(key);
      throw Object.assign(new Error("network"), { code: null });
    }
    if (options.budgetGone && key === "rows") {
      throw Object.assign(new Error("rate limit"), { code: "53400" });
    }
  };
  const source: ExportSource = {
    async manifest() {
      calls.push("manifest");
      return {
        format: "rail-account-export/1",
        generatedAt: "2026-10-26T10:00:00Z",
        accountId: ACCOUNT,
        counts: { hands: hands.length, player_notes: notes.length, posts: 1, saved_posts: 0, hand_uploads: 1 },
        uploadBytes: 7,
        inventory: INVENTORY,
      };
    },
    async profile() {
      calls.push("profile");
      return { account: { id: ACCOUNT, email: "a@example.test" } };
    },
    async hands(after: Cursor, limit: number, derived: boolean): Promise<HandsPage> {
      calls.push(`hands:${after ? (after.id as string) : "start"}:${limit}:${derived}`);
      maybeFail("hands");
      const start = after ? hands.findIndex((h) => h.id === after.id) + 1 : 0;
      const page = hands.slice(start, start + limit);
      const result: HandsPage = { hands: page, next: page.length === limit ? { id: page[page.length - 1].id } : null };
      if (derived) {
        result.hand_stats = page.flatMap((h) => [{ hand_id: h.id, seat: 1 }, { hand_id: h.id, seat: 2 }]);
        result.hand_stats_ev = [];
        result.hand_analysis = [];
        result.decision_analysis = page.map((h) => ({ hand_id: h.id, ord: 0 }));
      }
      return result;
    },
    async rows(reader, section, after, limit): Promise<RowsPage> {
      calls.push(`${reader}:${section}:${after ? JSON.stringify(after) : "start"}`);
      maybeFail("rows");
      let all: Record<string, unknown>[] = [];
      if (section === "player_notes") all = notes;
      if (section === "posts") all = [{ id: "p1", author_id: ACCOUNT, title: "Mine" }];
      if (section === "hand_uploads") all = [{ name: `${ACCOUNT}/up1/HH1.txt.0badc0de.gz`, size: 7 }];
      const start = after ? Number(after.at) : 0;
      const page = all.slice(start, start + limit);
      return { rows: page, next: start + limit < all.length ? { at: start + limit } : null };
    },
    async upload(name) {
      calls.push(`upload:${name}`);
      return new Uint8Array([31, 139, 8, 0, 9, 9, 9]);
    },
  };
  return { source, calls };
}

const readme = (locale: "en" | "hr") => (context: Parameters<typeof buildReadme>[1]) =>
  buildReadme((locale === "en" ? en : hr).yourData.readme, context);

describe("exportAccount", () => {
  it("writes the README, profile, hands a page a file with their derived rows, every section, originals and the manifest", async () => {
    const { source, calls } = fakeSource({ hands: 5, notes: 7 });
    const sink = new BlobSink();
    const progress: string[] = [];
    const result = await exportAccount(source, new ZipWriter(sink), {
      derived: true,
      originals: true,
      readme: readme("en"),
      handsPageSize: 2,
      rowsPageSize: 3,
      onProgress: (p) => progress.push(p.phase),
      now: () => new Date("2026-10-26T12:00:00Z"),
    });
    const files = await readAll(sink.toBlob());
    expect([...files.keys()]).toEqual([
      "README.md",
      "profile.json",
      "hands/hands-00001.ndjson",
      "hand_stats/hand_stats-00001.ndjson",
      "analysis/decision_analysis-00001.ndjson",
      "hands/hands-00002.ndjson",
      "hand_stats/hand_stats-00002.ndjson",
      "analysis/decision_analysis-00002.ndjson",
      "hands/hands-00003.ndjson",
      "hand_stats/hand_stats-00003.ndjson",
      "analysis/decision_analysis-00003.ndjson",
      "forum/posts.ndjson",
      "player_notes.ndjson",
      "originals/up1/HH1.txt.0badc0de.gz",
      "manifest.json",
    ]);
    // Every hand once, one JSON object a line, the PHF as given.
    const hands = ["hands/hands-00001.ndjson", "hands/hands-00002.ndjson", "hands/hands-00003.ndjson"]
      .flatMap((name) => files.get(name)!.trim().split("\n"))
      .map((line) => JSON.parse(line));
    expect(hands.map((h) => h.id)).toEqual(["h0000", "h0001", "h0002", "h0003", "h0004"]);
    expect(hands[3].phf).toEqual({ schema: "phf/1", i: 3 });
    expect(files.get("player_notes.ndjson")!.trim().split("\n")).toHaveLength(7);
    expect(calls.filter((c) => c.startsWith("rows:player_notes"))).toHaveLength(3); // 3 + 3 + 1
    expect(calls).toContain("sealed:posts:start");
    expect(files.has("forum/saved_posts.ndjson")).toBe(false); // nothing to write, no empty file
    expect(calls).toContain(`upload:${ACCOUNT}/up1/HH1.txt.0badc0de.gz`);

    const manifest = JSON.parse(files.get("manifest.json")!);
    expect(manifest.format).toBe("rail-account-export/1");
    expect(manifest.accountId).toBe(ACCOUNT);
    expect(manifest.options).toEqual({ derived: true, originals: true });
    expect(manifest.files.find((f: { name: string }) => f.name === "player_notes.ndjson").rows).toBe(7);
    expect(manifest.inventory).toHaveLength(INVENTORY.length);
    expect(result.rows).toBe(5 + 10 + 5 + 7 + 1);
    expect(progress[0]).toBe("manifest");
    expect(progress.at(-1)).toBe("done");

    const text = files.get("README.md")!;
    expect(text).toContain("# Your Rail data");
    expect(text).toContain("**public.hands** - included: `hands/hands-NNNN.ndjson`. Every stored hand.");
    expect(text).toContain("**public.hero_rollups** - not included (a summary rebuilt from the rows above it).");
    expect(text).toContain("**public.moderation_actions** - not included (moderation records naming other people");
    expect(text).toContain("**public.profiles** - in profile.json.");
  });

  it("without the options: no derived rows asked for, no originals read", async () => {
    const { source, calls } = fakeSource({ hands: 3, notes: 1 });
    const sink = new BlobSink();
    await exportAccount(source, new ZipWriter(sink), { derived: false, originals: false, readme: readme("hr") });
    const files = await readAll(sink.toBlob());
    expect([...files.keys()].some((name) => name.startsWith("hand_stats/") || name.startsWith("originals/"))).toBe(false);
    expect(calls.some((c) => c.startsWith("hands:") && c.endsWith(":true"))).toBe(false);
    expect(calls.some((c) => c.startsWith("upload:"))).toBe(false);
    expect(files.get("README.md")).toContain("# Tvoji podaci iz Raila");
    expect(files.get("README.md")).toContain("nisu uključeni");
  });

  it("a network blip is retried; the daily budget is not", async () => {
    const flaky = fakeSource({ hands: 3, notes: 2, failOnce: ["hands", "rows"] });
    const sleeps: number[] = [];
    await exportAccount(flaky.source, new ZipWriter(new BlobSink()), {
      derived: false,
      originals: false,
      readme: readme("en"),
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(sleeps).toEqual([500, 500]);

    const spent = fakeSource({ hands: 1, notes: 2, budgetGone: true });
    const slept: number[] = [];
    await expect(
      exportAccount(spent.source, new ZipWriter(new BlobSink()), {
        derived: false,
        originals: false,
        readme: readme("en"),
        sleep: async (ms) => void slept.push(ms),
      }),
    ).rejects.toMatchObject({ code: "53400" });
    expect(slept).toEqual([]);
  });

  it("cancel stops between pages", async () => {
    const { source } = fakeSource({ hands: 50, notes: 1 });
    const controller = new AbortController();
    let pages = 0;
    const wrapped: ExportSource = {
      ...source,
      async hands(after, limit, derived) {
        if (++pages === 3) controller.abort();
        return source.hands(after, limit, derived);
      },
    };
    await expect(
      exportAccount(wrapped, new ZipWriter(new BlobSink()), {
        derived: false,
        originals: false,
        readme: readme("en"),
        handsPageSize: 5,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ExportCancelled);
    expect(pages).toBe(3);
  });

  it("names the file after the account and the day", () => {
    expect(exportFileName("data_alice", new Date("2026-10-26T23:00:00Z"))).toBe("rail-export-data_alice-2026-10-26.zip");
    expect(exportFileName("../evil", new Date("2026-10-26T00:00:00Z"))).toBe("rail-export-evil-2026-10-26.zip");
    expect(exportFileName(null, new Date("2026-10-26T00:00:00Z"))).toBe("rail-export-account-2026-10-26.zip");
  });
});

// ---------------------------------------------------------------------------
// The deletion loop
// ---------------------------------------------------------------------------

describe("runAccountDeletion", () => {
  it("sends the username once, calls again while in progress, ends at deleted", async () => {
    const bodies: unknown[] = [];
    const answers: DeleteCallResult[] = [
      { status: "in_progress", step: "hands" },
      { status: "in_progress", step: "hands" },
      { status: "deleted" },
    ];
    const steps: (string | null)[] = [];
    const outcome = await runAccountDeletion(
      async (body) => {
        bodies.push(body);
        return answers.shift()!;
      },
      "data_alice",
      (step) => steps.push(step),
    );
    expect(outcome).toEqual({ status: "deleted" });
    expect(bodies).toEqual([{ confirm: "data_alice" }, {}, {}]);
    expect(steps).toEqual(["hands", "hands"]);
  });

  it("returns a refusal as it is, and resumes without a username", async () => {
    const bodies: unknown[] = [];
    expect(
      await runAccountDeletion(async (body) => {
        bodies.push(body);
        return { status: "error", code: "reauth_required" };
      }, null),
    ).toEqual({ status: "error", code: "reauth_required" });
    expect(bodies).toEqual([{}]);
  });

  it("signed out after the deletion was under way means the server finished it", async () => {
    const answers: DeleteCallResult[] = [
      { status: "in_progress", step: "hands" },
      { status: "error", code: "not_signed_in" },
    ];
    expect(await runAccountDeletion(async () => answers.shift()!, "x")).toEqual({ status: "deleted" });
    expect(await runAccountDeletion(async () => ({ status: "error", code: "not_signed_in" }), "x")).toEqual({
      status: "error",
      code: "not_signed_in",
    });
  });

  it("gives up after its call budget", async () => {
    expect(
      await runAccountDeletion(async () => ({ status: "in_progress", step: null }), "x", undefined, 3),
    ).toEqual({ status: "error", code: "unavailable" });
  });
});

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

const render = (locale: "en" | "hr", node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale }, node));

describe("the Your data and Delete account panels, en + hr", () => {
  it("the export panel offers the download and both options", () => {
    const enHtml = render("en", createElement(YourDataPanel, { username: "data_alice" }));
    expect(enHtml).toContain('id="your-data"');
    expect(enHtml).toContain("Download my data");
    expect(enHtml).toContain("Also include statistics and analysis");
    expect(enHtml).toContain("no copy is kept on our servers");
    const hrHtml = render("hr", createElement(YourDataPanel, { username: "data_alice" }));
    expect(hrHtml).toContain("Preuzmi moje podatke");
    expect(hrHtml).toContain("Uključi izvorne datoteke");
  });

  it("the progress names the phase and how much is written", () => {
    const progress = {
      phase: "hands" as const,
      handsDone: 250_000,
      handsTotal: 1_000_000,
      sectionsDone: 0,
      sectionsTotal: 40,
      originalsDone: 0,
      originalsTotal: 0,
      bytes: 123_400_000,
    };
    const enHtml = render("en", createElement(ExportProgressView, { progress, t: en.yourData.data, intl: "en-GB" }));
    expect(enHtml).toContain("Hands: 250,000 of 1,000,000");
    expect(enHtml).toContain('aria-valuenow="25"');
    expect(enHtml).toContain("123.4 MB written so far");
    const hrHtml = render("hr", createElement(ExportProgressView, { progress, t: hr.yourData.data, intl: "hr-HR" }));
    expect(hrHtml).toContain("Ruke: 250.000 od 1.000.000");
    expect(hrHtml).toContain("Dosad zapisano 123,4 MB");
    expect(formatSize(2_500_000_000, "en-GB")).toBe("2.5 GB");
    expect(formatSize(900, "en-GB")).toBe("1 kB");
  });

  it("the deletion explains what happens to the forum and the desktop app before anything is typed", () => {
    const enHtml = render("en", createElement(DeletionExplainer, { t: en.yourData.delete }));
    expect(enHtml).toContain("It cannot be undone");
    expect(enHtml).toContain("A post others replied to stays as");
    expect(enHtml).toContain("The desktop app keeps its own copy");
    const hrHtml = render("hr", createElement(DeletionExplainer, { t: hr.yourData.delete }));
    expect(hrHtml).toContain("Ne može se poništiti");
    expect(hrHtml).toContain("Desktop aplikacija čuva vlastitu kopiju");
    expect(en.yourData.delete.what).toHaveLength(hr.yourData.delete.what.length);
  });

  it("every refusal of the function has a sentence in both languages", () => {
    const codes = ["not_signed_in", "invalid_request", "reauth_required", "confirmation_mismatch", "rate_limited", "billing_unavailable", "unavailable"] as const;
    for (const code of codes) {
      expect(en.yourData.delete.errors[code].length).toBeGreaterThan(10);
      expect(hr.yourData.delete.errors[code].length).toBeGreaterThan(10);
      expect(hr.yourData.delete.errors[code]).not.toBe(en.yourData.delete.errors[code]);
    }
  });

  it("after the deletion the signed-out page says so", () => {
    expect(render("en", createElement(AccountDeletedNotice, { t: en.yourData.delete }))).toContain("Your account has been deleted");
    expect(render("hr", createElement(AccountDeletedNotice, { t: hr.yourData.delete }))).toContain("Tvoj račun je obrisan");
  });
});
