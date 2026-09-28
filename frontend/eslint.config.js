import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
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

      // These two are real and are tracked rather than fixed here: both are
      // components that F2/F3 rewrite wholesale (the replayer moves to PhfHand
      // and the chip sweep moves to the Web Animations API, which removes the
      // effect entirely). Downgraded so CI can gate on errors today instead of
      // waiting on a refactor. See issues #14 and #18.
      'react-hooks/set-state-in-effect': 'warn',
      // Exporting a helper beside a component only costs a full HMR reload in
      // dev. `reactRefresh.configs.vite` itself goes away with the Next.js move.
      'react-refresh/only-export-components': 'warn',
    },
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
])
