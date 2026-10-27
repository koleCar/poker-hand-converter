/**
 * The terms and the privacy policy (Rail R6.5): `docs/legal/*.md` served at
 * `/terms` and `/privacy`.
 *
 * - the module the pages import is exactly what `web/scripts/
 *   legal-docs.mjs` makes from the documents (edit a document, run the
 *   script - dev and build do);
 * - each document opens with the draft notice, the Croatian text has the same
 *   sections as the English, and the owner's placeholders are still marked;
 * - the small Markdown renderer: headings, lists, tables, bold, code, links -
 *   and nothing that is not ours (no HTML, no `javascript:` link);
 * - the page in English and Croatian, under the draft banner.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// @ts-expect-error - a plain ES module script, no declarations
import { generateLegalModule } from "../../web/scripts/legal-docs.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LegalDocument, legalTitle } from "../../web/src/components/legal/LegalDocument";
import { parseBlocks, renderMarkdown } from "../../web/src/lib/legal/markdown";
import { LEGAL_TEXTS } from "../../web/src/lib/legal/texts.generated";
import { en } from "../../web/src/lib/i18n/en";
import { hr } from "../../web/src/lib/i18n/hr";

const ROOT = join(import.meta.dirname, "../..");

describe("the legal documents", () => {
  it("the pages' module is generated from docs/legal, unchanged", () => {
    const committed = readFileSync(join(ROOT, "web/src/lib/legal/texts.generated.ts"), "utf8");
    expect(committed).toBe((generateLegalModule as () => string)());
  });

  for (const id of ["terms", "privacy"] as const) {
    it(`${id}: opens with the draft notice in both languages`, () => {
      const enFirst = parseBlocks(LEGAL_TEXTS[id].en)[1];
      const hrFirst = parseBlocks(LEGAL_TEXTS[id].hr)[1];
      expect(enFirst).toMatchObject({ kind: "quote" });
      expect(hrFirst).toMatchObject({ kind: "quote" });
      expect(enFirst.kind === "quote" && enFirst.text).toContain("Draft - not yet in force; pending the owner's and legal review.");
      expect(hrFirst.kind === "quote" && hrFirst.text).toContain("Nacrt - još nije na snazi; čeka pregled vlasnika i pravnika.");
      expect(enFirst.kind === "quote" && enFirst.text).toContain("not legal advice");
    });

    it(`${id}: the Croatian text has the English one's sections, and the placeholders are marked`, () => {
      const sections = (text: string) => parseBlocks(text).filter((b) => b.kind === "heading" && b.level === 2).length;
      expect(sections(LEGAL_TEXTS[id].hr)).toBe(sections(LEGAL_TEXTS[id].en));
      expect(sections(LEGAL_TEXTS[id].en)).toBeGreaterThan(8);
      expect(LEGAL_TEXTS[id].en).toContain("[OWNER:");
      expect(LEGAL_TEXTS[id].hr).toContain("[VLASNIK:");
      // No invented identity: the entity, address and OIB stay placeholders.
      expect(LEGAL_TEXTS[id].en).toMatch(/\[OWNER: legal name/);
      expect(LEGAL_TEXTS[id].en).toMatch(/\[OWNER: OIB/);
    });
  }

  it("the privacy policy names the data flows the code has", () => {
    const text = LEGAL_TEXTS.privacy.en;
    for (const fact of [
      "never leaves it",
      "Frankfurt",
      "Supabase",
      "Vercel",
      "Stripe",
      "Resend",
      "Turnstile",
      "No advertising, analytics or tracking",
      "Download my data",
      "Delete account",
      "app.rail.desktop",
      "AZOP",
    ]) {
      expect(text, fact).toContain(fact);
    }
  });
});

describe("the Markdown renderer", () => {
  const html = (source: string) => renderToStaticMarkup(createElement("div", null, ...renderMarkdown(source)));

  it("renders the subset the documents use", () => {
    const out = html(
      [
        "# Title",
        "",
        "> **Draft** - a note",
        "> that wraps.",
        "",
        "## Section",
        "",
        "Text with **bold**, `code` and a [link](/privacy) and [another](https://example.com/x).",
        "",
        "- one item",
        "  that wraps",
        "- two",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | **2** |",
      ].join("\n"),
    );
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<blockquote><strong>Draft</strong> - a note that wraps.</blockquote>");
    expect(out).toContain("<h2>Section</h2>");
    expect(out).toContain('<strong>bold</strong>, <code>code</code> and a <a href="/privacy">link</a>');
    expect(out).toContain('<a href="https://example.com/x">another</a>');
    expect(out).toContain("<li>one item that wraps</li><li>two</li>");
    expect(out).toContain('<th scope="col">A</th>');
    expect(out).toContain("<td><strong>2</strong></td>");
  });

  it("passes no HTML through and links only here or to https", () => {
    const out = html("A <script>alert(1)</script> [x](javascript:alert(1)) [y](//evil.example) [z](http://plain.example)");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("href=");
  });

  it("can leave out the title the page shows itself", () => {
    expect(html("# T\n\nBody")).toContain("<h1>T</h1>");
    expect(renderToStaticMarkup(createElement("div", null, ...renderMarkdown("# T\n\nBody", { skipTitle: true })))).toBe("<div><p>Body</p></div>");
  });
});

describe("the pages", () => {
  it("show the document in the reader's language under the draft banner", () => {
    const enHtml = renderToStaticMarkup(createElement(LegalDocument, { id: "privacy", locale: "en", draft: en.legal.draft }));
    expect(enHtml).toContain('lang="en"');
    expect(enHtml).toContain("Draft - not yet in force.");
    expect(enHtml).toContain("<h1");
    expect(enHtml).toContain("Privacy policy");
    const hrHtml = renderToStaticMarkup(createElement(LegalDocument, { id: "terms", locale: "hr", draft: hr.legal.draft }));
    expect(hrHtml).toContain('lang="hr"');
    expect(hrHtml).toContain("Nacrt - još nije na snazi.");
    expect(hrHtml).toContain("Uvjeti korištenja");
    expect(legalTitle("terms", "en")).toBe("Terms of use");
    expect(legalTitle("privacy", "hr")).toBe("Pravila privatnosti");
  });
});
