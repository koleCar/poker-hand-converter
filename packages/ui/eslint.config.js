import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

/**
 * The shared UI package's rules: the web's and the app's, plus the two that
 * make it shareable.
 *
 * 1. **No backend, no framework.** The package runs in a Next.js page and in a
 *    Tauri webview. Supabase belongs to the web (`frontend/src/lib/db/`), Tauri
 *    to the app (`app/src/lib/`); a component that fetches goes through the
 *    `DataSource` the surface provides (`data.tsx`).
 * 2. **One door out.** The package reaches outside itself only through
 *    `model/` (the web's framework-free library: PHF, replay frames, cards,
 *    statistics types), so that dependency is one directory to read and, at
 *    R0.14, one directory to repoint.
 *
 * And the surfaces' i18n rule: no user-facing literal in a component. Words
 * arrive through `UiStringsProvider` (`i18n.tsx`) or as props.
 */
const NO_BARE_LITERAL =
  "User-facing string literal. @rail/ui holds no copy: add it to UiStrings (i18n.tsx), filled by each surface's dictionaries, or take it as a prop.";

const BACKEND = {
  group: ["next", "next/*", "server-only", "client-only", "@supabase/*", "@tauri-apps/*"],
  message:
    "@rail/ui runs on the web and in the desktop app: no framework or backend imports. Fetch through the DataSource (data.tsx).",
};

export default defineConfig([
  globalIgnores(["node_modules"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      // As on the web (frontend/eslint.config.js): the replayer's effects that
      // set state are tracked there (issues #14 and #18), not rewritten in a
      // move.
      "react-hooks/set-state-in-effect": "warn",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            BACKEND,
            {
              group: ["**/frontend/**", "**/app/src/**", "@/*"],
              message: "@rail/ui reaches outside itself only through model/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["model/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [BACKEND] }],
    },
  },
  {
    files: ["**/*.tsx"],
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
]);
