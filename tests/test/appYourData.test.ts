/**
 * The desktop app's Settings -> Account -> Your data (Rail R6.5): it says
 * what this computer keeps and how to remove it, in both languages, and its
 * buttons open the web's export, deletion and privacy pages by name - the
 * app never builds the URL itself (`account::web_page_path` in Rust does,
 * from a fixed list; tested there).
 */

import "./support/appWindow";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DictProvider } from "../../app/src/i18n/index";
import { en } from "../../app/src/i18n/en";
import { hr } from "../../app/src/i18n/hr";
import { ipc } from "../../app/src/lib/ipc";
import { YourData } from "../../app/src/screens/settings/YourData";
import { setInvokeHandler } from "./support/tauriCore";

const render = (locale: "en" | "hr") =>
  renderToStaticMarkup(createElement(DictProvider, { locale }, createElement(YourData)));

describe("desktop Settings -> Account -> Your data", () => {
  it("explains the local data and offers the web's export and deletion, in English", () => {
    const html = render("en");
    expect(html).toContain(en.account.yourData.heading);
    expect(html).toContain("in a database on this computer");
    expect(html).toContain("quit Rail (also from the tray), uninstall it, then delete the folders above");
    expect(html).toContain("Download my account&#x27;s data");
    expect(html).toContain("Delete my account…");
    expect(html).toContain("Deleting the account does not touch the data on this computer.");
  });

  it("and in Croatian", () => {
    const html = render("hr");
    expect(html).toContain(hr.account.yourData.heading);
    expect(html).toContain("Obriši moj račun…");
    expect(html).toContain("Brisanje računa ne dira podatke na ovom računalu.");
  });

  it("opens a web page by its name only", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    setInvokeHandler((command, args) => {
      calls.push([command, args]);
      return null;
    });
    await ipc.accountOpenWebPage("delete-account");
    await ipc.accountOpenWebPage("your-data");
    await ipc.accountOpenWebPage("privacy");
    expect(calls).toEqual([
      ["account_open_web_page", { page: "delete-account" }],
      ["account_open_web_page", { page: "your-data" }],
      ["account_open_web_page", { page: "privacy" }],
    ]);
  });
});
