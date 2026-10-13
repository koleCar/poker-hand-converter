import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

/**
 * The web's "no bare user-facing literal" rule (`frontend/eslint.config.js`),
 * the same two selectors: JSX text with words in it, and a string literal on
 * an attribute that is shown or read aloud. Copy lives in `src/i18n/`.
 */
const NO_BARE_LITERAL =
  "User-facing string literal. Put it in `src/i18n/en.ts` (and `hr.ts`) and reference it through `useT()`.";

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
      ],
    },
  },
  {
    files: ["vite.config.ts"],
    languageOptions: { globals: globals.node },
  },
]);
