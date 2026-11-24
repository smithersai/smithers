import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * `@smthrs/ui` publishes its sources (`files: ["src/"]`, every export condition
 * names a `.ts`/`.tsx` file), so a consumer's type check reads `src/` and
 * resolves each of its imports from the installed package. A declaration that
 * only a devDependency supplies is absent there: `@types/d3-force` sat in
 * devDependencies, and every consumer of the vault components failed with
 * TS7016 on `import type { Simulation } from "d3-force"` (evmts/tevm
 * `sites/contributor`, `@smthrs/ui@0.33.0`).
 *
 * The rule: every package `src/` imports is a dependency or a peer, and a
 * dependency's declarations, its own or DefinitelyTyped's, come from a package
 * in `dependencies`. A peer's declarations ride with the consumer's install of
 * that peer (`@types/react` with `react`), so only declaring the peer is
 * required.
 */
const packageRoot = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};
const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));

/**
 * Every bare specifier a file names in a form a type check follows: import and
 * export declarations (`import type` included), `import x = require()`,
 * `import()` calls, and `import()` types such as `typeof import("x")`.
 */
function bareSpecifiers(fileName: string, text: string): ReadonlyArray<string> {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const found: Array<string> = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (ts.isStringLiteral(node.moduleReference.expression)) found.push(node.moduleReference.expression.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (ts.isStringLiteral(node.argument.literal)) found.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteralLike(argument)) found.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("/") && !isBuiltin(specifier));
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return (specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
}

/** DefinitelyTyped's package for `name`: `@types/name`, or `@types/scope__name` for `@scope/name`. */
function typesPackageOf(name: string): string {
  return `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
}

const typeScriptExtensions = new Set<string>([
  ts.Extension.Dts,
  ts.Extension.Dmts,
  ts.Extension.Dcts,
  ts.Extension.Ts,
  ts.Extension.Tsx,
  ts.Extension.Mts,
  ts.Extension.Cts,
]);

/**
 * Every way `src/` would fail a consumer's type check, one line per file and
 * specifier, with the number of import sites checked.
 */
function consumerDeclarations(): { readonly checked: number; readonly failures: ReadonlyArray<string> } {
  const config = ts.getParsedCommandLineOfConfigFile(join(packageRoot, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (config === undefined) throw new Error("could not read tsconfig.json");
  const cache = ts.createModuleResolutionCache(packageRoot, (name) => name, config.options);
  const files = readdirSync(join(packageRoot, "src"), { recursive: true, encoding: "utf8" })
    .filter((name) => /\.(tsx?|vibe)$/.test(name))
    .map((name) => join(packageRoot, "src", name));

  let checked = 0;
  const failures = new Set<string>();
  for (const file of files) {
    const at = relative(packageRoot, file);
    for (const specifier of bareSpecifiers(file, readFileSync(file, "utf8"))) {
      const name = packageOf(specifier);
      if (name === manifest.name) continue;
      checked += 1;
      if (!dependencies.has(name) && !peers.has(name)) {
        failures.add(`${at}: ${specifier}: ${name} is in neither dependencies nor peerDependencies`);
        continue;
      }
      const resolved = ts.resolveModuleName(specifier, file, config.options, ts.sys, cache).resolvedModule;
      if (resolved === undefined || !typeScriptExtensions.has(resolved.extension)) {
        failures.add(`${at}: ${specifier}: no declarations resolve`);
        continue;
      }
      const provider = resolved.packageId?.name ?? name;
      const shipped = dependencies.has(name)
        ? dependencies.has(provider)
        : provider === name || provider === typesPackageOf(name);
      if (!shipped) {
        failures.add(`${at}: ${specifier}: its declarations come from ${provider}, which is not in dependencies`);
      }
    }
  }
  return { checked, failures: [...failures].sort() };
}

describe("consumer declarations", () => {
  test("the scan reads every import form a type check follows, and only those", () => {
    const text = [
      'import type { Simulation } from "type-only";',
      'type Force = typeof import("import-type");',
      'export * from "@scope/reexport/sub";',
      'export type { Node } from "export-type";',
      'const load = () => import("dynamic");',
      'import "side-effect";',
      'import legacy = require("import-equals");',
      'import { local } from "./relative";',
      'import { readFileSync } from "node:fs";',
      '// import "comment";',
      'const text = "import(\'string\')";',
    ].join("\n");
    expect(bareSpecifiers("fixture.ts", text)).toEqual([
      "type-only",
      "import-type",
      "@scope/reexport/sub",
      "export-type",
      "dynamic",
      "side-effect",
      "import-equals",
    ]);
  });

  test("names DefinitelyTyped's package for plain and scoped names", () => {
    expect(packageOf("@codemirror/view/sub")).toBe("@codemirror/view");
    expect(packageOf("react-dom/server")).toBe("react-dom");
    expect(typesPackageOf("d3-force")).toBe("@types/d3-force");
    expect(typesPackageOf("@scope/name")).toBe("@types/scope__name");
  });

  test("every package src/ imports reaches a consumer with its declarations", () => {
    const { checked, failures } = consumerDeclarations();
    // Guard the guard: a scan that found no imports would report no failures.
    expect(checked).toBeGreaterThan(300);
    expect(failures).toEqual([]);
  }, 60_000);
});
