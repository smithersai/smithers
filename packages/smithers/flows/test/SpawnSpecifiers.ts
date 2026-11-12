/**
 * Whether a source file BINDS a module that can start a process.
 *
 * Containment is a property of the `ChildProcessSpawner` service: a host
 * decorates it once (`ContainedSpawner` adds `forceKillAfter ?? graceMs` and a
 * `ProcessLedger` record) and every module that resolves the tag inherits the
 * kill deadline and the journal entry. A module that reaches for
 * `node:child_process` directly inherits neither, and no behavioral test can
 * see that: the module works, its suite is green, and the only symptom is a
 * process still running on someone's machine after the flow that started it
 * was cancelled. So the bypass is checked for by reading source.
 *
 * This module is the reader. Two suites use it —
 * `packages/smithers/agent/std/test/ExecContainment.test.ts` over `packages/smithers/agent/std/src` alone,
 * where it fails fast during work on that package, and
 * `packages/repo-targets/conformance/spawnContainment.test.ts` over every package — and
 * they share one implementation so the tree-wide gate can never be narrower
 * than the package-local one.
 *
 * It reads the TypeScript SYNTAX TREE rather than the text, because three
 * regex versions of this gate were each one layout wide. The last one matched
 * `^\s*import\s[^\n]*?from\s*"node:child_process"`, which the repository's own
 * formatter walks straight through: `dprint` breaks any import over 120
 * characters into `import {` … `} from "node:child_process"`, and a
 * single-line pattern cannot cross that break. Stripping comments first and
 * matching on position instead is no better, because a `//` inside a string
 * literal then eats the rest of the line. A parser has no such edge: an import
 * is an import in every layout, and a comment is not a node at all.
 */
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import * as ts from "typescript"
import { findCompiler } from "vibelang/project"
import { hasVibeDirective } from "vibelang/source"

/**
 * The modules whose import is the thing being gated, in every spelling that
 * binds them.
 *
 * The `node:` prefix is optional because omitting it binds exactly the same
 * module, and nothing in this repository requires the prefix: no
 * `packages/*\/eslint.config.js` configures `unicorn/prefer-node-protocol` or
 * `no-restricted-imports`. A gate that matched only the prefixed spelling
 * would be one token wide.
 *
 * `cluster` is here beside `child_process` because `cluster.fork()` starts a
 * process the same way and inherits the same nothing. Threads are out of
 * scope: a `node:worker_threads` worker dies with the process that made it.
 */
export const spawningModules: ReadonlySet<string> = new Set([
  "child_process",
  "node:child_process",
  "cluster",
  "node:cluster"
])

/**
 * Extensions a module in this repository can be written in.
 *
 * `.ts` alone was the universe at first, which silently excluded the 86 `.tsx`
 * components and the two `.js` entry points under `packages/*\/src`. None of
 * them spawns today, so the hole was prospective, but a gate whose whole job
 * is the bypass nobody has written yet cannot choose which files that bypass
 * is allowed to be written in. The same went for the VibeLang modules
 * (`.vibe`, `.vibex`) the repository is being rewritten into.
 */
export const sourceExtensions: ReadonlyArray<string> = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vibe",
  ".vibex"
]

/**
 * How to parse a path's {@link typeScriptText}, so JSX and TypeScript syntax
 * both survive the scan.
 *
 * A `.tsx` file parsed as `.ts` loses every element to a type-assertion
 * ambiguity, and the imports above them go with it.
 */
export const scriptKind = (path: string): ts.ScriptKind =>
  path.endsWith(".tsx") || path.endsWith(".vibex")
    ? ts.ScriptKind.TSX
    : path.endsWith(".jsx")
    ? ts.ScriptKind.JSX
    : path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts") || path.endsWith(".vibe")
    ? ts.ScriptKind.TS
    : ts.ScriptKind.JS

let compiler: string | undefined

/**
 * The TypeScript the parser reads for a module: the source itself, or for a
 * VibeLang module (`.vibe`, `.vibex`, or a TypeScript file with the `// @vibe`
 * directive) the projection VibeLang gives linters (`vibelang
 * --ts-projection`). The TypeScript parser does not accept every VibeLang form,
 * and the projection lowers them while keeping each import and call, and
 * every line, where the module has it.
 *
 * @param source The file's text.
 * @param path Chooses the language; it need not exist.
 */
export const typeScriptText = (source: string, path: string): string => {
  if (!/\.vibex?$/.test(path) && !hasVibeDirective(path, source)) return source
  compiler ??= findCompiler(import.meta.dirname)
  const output = execFileSync(compiler, ["--ts-projection", path], {
    input: source,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
  return (JSON.parse(output) as { readonly text: string }).text
}

/**
 * A specifier that names one of the process-starting modules.
 *
 * `isStringLiteralLike` accepts a backtick with no substitutions as well as
 * either quote, because a dynamic import takes a template literal just as
 * happily as a string. A template WITH substitutions is not matched: its text
 * is not known here, and nothing in this repository builds a specifier that
 * way.
 */
const namesSpawningModule = (node: ts.Node | undefined): boolean =>
  node !== undefined && ts.isStringLiteralLike(node) && spawningModules.has(node.text)

/**
 * Whether this source binds a process-starting module, in any layout.
 *
 * Every form the language offers is one of four node shapes:
 *
 *  - `ImportDeclaration` and `ExportDeclaration` cover `import x from`,
 *    `import type`, `import * as`, the side-effect `import "…"` with no
 *    clause at all, `export { … } from`, and `export * from`, each over any
 *    number of lines and with an import-attributes clause or without one;
 *  - `ImportEqualsDeclaration` covers `import x = require("…")`;
 *  - `ImportTypeNode` covers `typeof import("…")` in type position;
 *  - a call or `new` whose FIRST ARGUMENT is the specifier covers `import()`,
 *    `require()`, `createRequire(import.meta.url)("…")`,
 *    `process.getBuiltinModule("…")`, and any loader helper written next year.
 *    The callee is deliberately not checked: passing one of these specifiers
 *    as the first argument of anything is the bypass, whatever the helper is
 *    called.
 *
 * Prose is not matched, and needs no rule to keep it unmatched: a comment is
 * trivia, not a node, so a module that quotes the very import line it is
 * warning against is clean. A specifier sitting in a plain string is not
 * matched either, because a string that is not an argument binds nothing.
 *
 * @param source The file's text.
 * @param path Chooses the language and the parser's script kind; it need not
 *   exist.
 */
export const bindsSpawningModule = (source: string, path = "source.ts"): boolean => {
  const parsed = ts.createSourceFile(
    path,
    typeScriptText(source, path),
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path)
  )
  const visit = (node: ts.Node): true | undefined => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && namesSpawningModule(node.moduleSpecifier)) {
      return true
    }
    if (
      ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && namesSpawningModule(node.moduleReference.expression)
    ) {
      return true
    }
    if (
      ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && namesSpawningModule(node.argument.literal)
    ) {
      return true
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && namesSpawningModule(node.arguments?.[0])) {
      return true
    }
    return ts.forEachChild(node, visit)
  }
  return visit(parsed) === true
}

/** Whether the file at `path` binds a process-starting module. */
export const fileBindsSpawningModule = (path: string): boolean => bindsSpawningModule(readFileSync(path, "utf8"), path)

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every source module under `root`, recursively, sorted.
 *
 * The universe is walked rather than listed, so a file added tomorrow is
 * covered without anyone remembering to add it here.
 *
 * @param root An existing directory. A path that is not one yields nothing.
 */
export const collectSources = (root: string): Array<string> => {
  const found: Array<string> = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (isDirectory(path)) walk(path)
      else if (sourceExtensions.some((extension) => path.endsWith(extension))) found.push(path)
    }
  }
  if (isDirectory(root)) walk(root)
  return found.sort()
}
