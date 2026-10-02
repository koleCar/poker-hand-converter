import { readFileSync } from "node:fs";
import ts from "typescript";
for (const f of process.argv.slice(2)) {
  const src = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = [];
  const visit = (node) => {
    if (ts.isJsxText(node) && /[\p{L}\p{N}][\p{L}\p{N} ]/u.test(node.text)) hits.push(node.text.trim().slice(0, 70));
    if (ts.isJsxAttribute(node) && /^(alt|title|placeholder|aria-label)$/.test(node.name.getText()) && node.initializer && ts.isStringLiteral(node.initializer) && /\p{L}/u.test(node.initializer.text)) hits.push("@" + node.initializer.text.slice(0, 70));
    if (ts.isStringLiteral(node) && /^[A-Z][a-z].* .*/.test(node.text) && !ts.isImportDeclaration(node.parent) && !ts.isJsxAttribute(node.parent)) hits.push("'" + node.text.slice(0, 70));
    ts.forEachChild(node, visit);
  };
  visit(src);
  if (hits.length) console.log("== " + f + "\n  " + hits.join("\n  "));
}
