import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

/**
 * The web's "no bare user-facing literal" rule (`web/eslint.config.js`),
 * the same two selectors: JSX text with words in it, and a string literal on
 * an attribute that is shown or read aloud. Copy lives in `src/i18n/`.
 */
const NO_BARE_LITERAL =
  "User-facing string literal. Put it in `src/i18n/en.ts` (and `hr.ts`) and reference it through `useT()`.";

/** Attributes whose text is shown or read aloud: the platform's and the app's own components' (R2.8). */
const SHOWN_ATTRIBUTES =
  "/^(alt|title|placeholder|aria-label|aria-description|aria-placeholder|aria-roledescription|aria-valuetext|label|caption|lead|heading|detail|emptyText|busyText)$/";

/** Two letters in a row: a word, not a sign ("—", "×", "✎", "+"). */
const WORDS = "/\\p{L}\\p{L}/u";

export default defineConfig([
  globalIgnores(["dist", "src-tauri"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
  {
    files: ["src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXText[value=/[\\p{L}\\p{N}][\\p{L}\\p{N} ]/u]",
          message: NO_BARE_LITERAL,
        },
        {
          selector:
            "JSXAttribute[name.name=/^(alt|title|placeholder|aria-label|aria-description|aria-placeholder)$/] > Literal[value=/[\\p{L}\\p{N}]/u]",
          message: NO_BARE_LITERAL,
        },
        // R2.8, the i18n audit: what the two rules above let through.
        // Text as an expression child (`{"Loading"}`), chosen in place
        // (`{busy ? "Saving" : label}`, `{error && "Failed"}`) or templated
        // (`{`${n} hands`}`).
        {
          selector: `:matches(JSXElement, JSXFragment) > JSXExpressionContainer > Literal[value=${WORDS}]`,
          message: NO_BARE_LITERAL,
        },
        {
          selector: `:matches(JSXElement, JSXFragment) > JSXExpressionContainer > :matches(ConditionalExpression, LogicalExpression) > Literal[value=${WORDS}]`,
          message: NO_BARE_LITERAL,
        },
        {
          selector: `:matches(JSXElement, JSXFragment) > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=${WORDS}]`,
          message: NO_BARE_LITERAL,
        },
        // The same on an attribute that is shown or read aloud, the app's
        // components' text props included (`label`, `caption`, `emptyText`…).
        {
          selector: `JSXAttribute[name.name=${SHOWN_ATTRIBUTES}] > Literal[value=${WORDS}]`,
          message: NO_BARE_LITERAL,
        },
        {
          selector: `JSXAttribute[name.name=${SHOWN_ATTRIBUTES}] > JSXExpressionContainer > Literal[value=${WORDS}]`,
          message: NO_BARE_LITERAL,
        },
        {
          selector: `JSXAttribute[name.name=${SHOWN_ATTRIBUTES}] > JSXExpressionContainer > :matches(ConditionalExpression, LogicalExpression) > Literal[value=${WORDS}]`,
          message: NO_BARE_LITERAL,
        },
        {
          selector: `JSXAttribute[name.name=${SHOWN_ATTRIBUTES}] > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=${WORDS}]`,
          message: NO_BARE_LITERAL,
        },
      ],
    },
  },
  {
    files: ["vite.config.ts"],
    languageOptions: { globals: globals.node },
  },
  // (R5.4) The web's library is reached through two doors,
  // `src/analysis/library.ts` (the analysis) and `src/analysis/leakWords.ts` (the
  // top leaks' ranking and words), which name exactly what the app uses of it.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/analysis/library.ts", "src/analysis/leakWords.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@rail/web-lib", "@rail/web-lib/*", "**/web/src/**"],
              message: "The web's library is the app's through `src/analysis/library.ts` and `leakWords.ts` only (R5.4).",
            },
          ],
        },
      ],
    },
  },
]);
