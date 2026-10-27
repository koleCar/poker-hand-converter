/**
 * Side-effect imports of plain stylesheets.
 *
 * Vite's `vite/client` types used to declare this. Next declares `*.module.css`
 * (see `next/types/global.d.ts`) but not `*.css`, because its own template has
 * one global sheet imported from the layout and nothing else — whereas this app
 * has eleven, imported from the components that own them so Next can
 * code-split them onto the routes that use them.
 *
 * `noUncheckedSideEffectImports` is on in `tsconfig.json`, which is why the
 * absence is an error rather than an implicit `any`. That flag is worth keeping:
 * it is what catches a side-effect import of a path that no longer exists, and
 * a stylesheet that silently stops being bundled is exactly the kind of breakage
 * that only shows up as "the page looks slightly wrong".
 *
 * The wildcard is deliberately less specific than Next's `*.module.css`, so CSS
 * Modules keep their real typed export. TypeScript resolves the longest matching
 * pattern.
 */
declare module "*.css";
