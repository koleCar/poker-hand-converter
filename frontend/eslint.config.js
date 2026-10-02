import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * The "no bare user-facing literal" rule, spelled out with `no-restricted-syntax`.
 *
 * Two selectors, and between them they catch the shapes that actually reach a
 * reader:
 *
 *   1. `JSXText` — the words between tags.
 *   2. a string literal on one of the attributes that renders as text or is read
 *      aloud: `alt`, `title`, `placeholder`, `aria-label`, `aria-description`.
 *
 * Both allow the escape hatches that are not copy: whitespace-only JSX text (the
 * newlines JSX leaves behind between elements), and single punctuation marks
 * like the `♠` and `·` this app uses as decoration, which are the same glyph in
 * every language and would be noise in a translation file.
 *
 * Deliberately implemented with a stock rule rather than by adding
 * `eslint-plugin-react`: it is four lines of selector against a plugin, a peer
 * dependency and a settings block, and the plugin's `jsx-no-literals` does not
 * cover attributes at all.
 */
const NO_BARE_LITERAL = 'User-facing string literal. Put it in `src/lib/i18n/en.ts` and reference it — see the header of that file for why.'

const i18nRules = {
  'no-restricted-syntax': [
    'error',
    {
      // JSX text with at least two non-whitespace, non-punctuation characters.
      selector: 'JSXText[value=/[\\p{L}\\p{N}][\\p{L}\\p{N} ]/u]',
      message: NO_BARE_LITERAL,
    },
    {
      selector:
        'JSXAttribute[name.name=/^(alt|title|placeholder|aria-label|aria-description|aria-placeholder)$/] > Literal[value=/[\\p{L}\\p{N}]/u]',
      message: NO_BARE_LITERAL,
    },
  ],
}

export default defineConfig([
  globalIgnores(['.next', 'next-env.d.ts']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // A U+FEFF inside a regex literal is deliberate here, not a stray paste:
      // 27 of these are parsers matching a real byte-order mark at the head of a
      // real export file (see `p5RecoverEncoding` and the Winamax detector).
      // The default already skips strings; regexes are where this codebase puts
      // them, because the BOM is part of the grammar it has to match.
      'no-irregular-whitespace': [
        'error',
        { skipStrings: true, skipTemplates: true, skipRegExps: true, skipComments: true },
      ],

      // Real, and tracked rather than fixed here: these are components that F2/F3
      // rewrite wholesale (the replayer moves to PhfHand and the chip sweep moves
      // to the Web Animations API, which removes the effect entirely).
      // Downgraded so CI can gate on errors today instead of waiting on a
      // refactor. See issues #14 and #18.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },

  /**
   * i18n: no bare user-facing literal in any screen — `src/app/**` and
   * `src/components/**`. Copy lives in `src/lib/i18n/` (`en.ts`, `hr.ts` and
   * the per-area files in `ns/`); see the header of `en.ts` for how a
   * component reaches it. Names that are not prose (the wordmark, a table or
   * file name shown in `<code>`) go through a named constant, which says so.
   */
  {
    files: ['src/app/**/*.tsx', 'src/components/**/*.tsx'],
    rules: i18nRules,
  },

  {
    // Byte recovery is this layer's entire job: it strips NUL bytes and
    // mojibake BOMs out of files that real poker rooms really wrote. A control
    // character in a regex here is the feature.
    files: ['src/lib/parsers/**/*.ts', 'src/lib/phf/**/*.ts'],
    rules: {
      'no-control-regex': 'off',
    },
  },

  /**
   * The rule that keeps the test harness alive.
   *
   * `tests/test/*.ts` imports these modules directly, by relative path, under
   * plain Node with no bundler and no framework. 3114 tests across 435 fixtures
   * hang off that. A single `import ... from "next/headers"` or a
   * `process.env.X` anywhere in this subtree breaks all of them at once, and the
   * failure reads as an unrelated module-resolution error rather than as
   * "somebody put a framework import in the parser layer".
   *
   * Anything Next-shaped belongs in `lib/supabase/`, `lib/server/` or `app/`.
   * `lib/routes.ts` and `lib/i18n/` are deliberately outside this list: they are
   * app configuration, not corpus code, and nothing in `tests/test` imports
   * them.
   */
  {
    files: [
      'src/lib/phf/**/*.ts',
      'src/lib/parsers/**/*.ts',
      'src/lib/stats/**/*.ts',
      'src/lib/replay.ts',
      'src/lib/cards.ts',
      'src/lib/format.ts',
      'src/lib/converter.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*', 'server-only', 'client-only'],
              message:
                'The pure-TypeScript library layer is imported directly by tests/test under plain Node. Framework imports belong in lib/supabase/, lib/server/ or app/.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'The pure-TypeScript library layer must not read configuration. Pass it in, or put the module in lib/server/.',
        },
      ],
    },
  },

  /**
   * The solver's import rule (header of `src/lib/solver/index.ts`).
   *
   * The same reason as the block above, and one more: `lib/solver` also runs in
   * a Web Worker, where there is no `window`, no `document` and no framework.
   * So it gets an allow-list rather than a deny-list - `lib/phf/types`,
   * `lib/cards` and `lib/equity`, nothing else from the app.
   */
  {
    files: ['src/lib/solver/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*', 'server-only', 'client-only', 'react', 'react/*', 'react-dom', '@supabase/*'],
              message:
                'lib/solver runs under plain Node in tests/test and in a Web Worker. No framework imports.',
            },
            {
              group: ['../*', '!../equity', '!../cards', '!../phf/types', '@/*'],
              message: 'lib/solver may import only lib/phf/types, lib/cards and lib/equity.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'lib/solver runs in a Web Worker; there is no window.' },
        { name: 'document', message: 'lib/solver runs in a Web Worker; there is no document.' },
        { name: 'process', message: 'lib/solver runs in the browser too. Pass configuration in.' },
      ],
    },
  },
])
