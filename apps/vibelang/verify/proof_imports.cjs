// Value imports can expose assumed contracts. Read syntax, including aliases, re-exports and single quotes.
const fs = require("node:fs");
const path = require("node:path");
const { ts } = require(path.resolve(__dirname, "../../../packages/lemmascript/node_modules/ts-morph"));
const file = process.argv[2];
const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
if (source.parseDiagnostics.length) throw new Error("Cannot inspect proof imports in " + file);
const imports = [];
function add(specifier, values) {
  if (!ts.isStringLiteralLike(specifier)) throw new Error("A proof import must be a literal module name");
  imports.push({ module: specifier.text, values });
}
function visit(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    const bindings = clause?.namedBindings;
    const typed = clause?.isTypeOnly || (clause && !clause.name && bindings && ts.isNamedImports(bindings)
      && bindings.elements.length > 0 && bindings.elements.every((item) => item.isTypeOnly));
    add(node.moduleSpecifier, !typed);
  } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    const clause = node.exportClause;
    const typed = node.isTypeOnly || (clause && ts.isNamedExports(clause) && clause.elements.length > 0
      && clause.elements.every((item) => item.isTypeOnly));
    add(node.moduleSpecifier, !typed);
  } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    add(node.moduleReference.expression, !node.isTypeOnly);
  } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
    add(node.arguments[0], true);
  }
  ts.forEachChild(node, visit);
}
visit(source);
process.stdout.write(JSON.stringify(imports));
