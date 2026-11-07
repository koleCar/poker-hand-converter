/**
 * The desktop app's Settings -> Danger zone (Rail R6.5): "Delete my account"
 * in both languages, and its button opens the web's deletion page by name -
 * the app never builds the URL itself (`account::web_page_path` in Rust does,
 * from a fixed list; tested there), and never deletes an account itself.
 */

import "./support/appWindow";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DictProvider } from "../../app/src/i18n/index";
import { en } from "../../app/src/i18n/en";
import { hr } from "../../app/src/i18n/hr";
import { ipc } from "../../app/src/lib/ipc";
import { DangerZone } from "../../app/src/screens/settings/DangerZone";
import { setInvokeHandler } from "./support/tauriCore";

const render = (locale: "en" | "hr") =>
  renderToStaticMarkup(createElement(DictProvider, { locale }, createElement(DangerZone)));

describe("desktop Settings -> Danger zone", () => {
  it("offers to delete the account, in English", () => {
    const html = render("en");
    expect(html).toContain(en.settings.sections.danger);
    expect(html).toContain("Delete my account");
    expect(html).toContain(">Delete…<");
  });

  it("and in Croatian", () => {
    const html = render("hr");
    expect(html).toContain(hr.settings.sections.danger);
    expect(html).toContain("Obriši moj račun");
    expect(html).toContain(">Obriši…<");
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
