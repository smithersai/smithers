import { join, relative, resolve } from "node:path"
import ts from "typescript"
import { expect, test } from "vitest"

// The data gate (decision 0110, 2026-11-03): a repository's rows reach a page only through a store's live queries,
// each joined to `repo-visible` (src/features/repo/gate.ts). A store's raw collections stay inside it. This walk holds
// the code to that with the type checker: outside a store's own modules, nothing reads a raw collection whose rows
// name a repository. A raw collection read elsewhere is the person's own, declared in `PERSONAL`, and its rows name
// no repository.

const ROOT = resolve(import.meta.dirname, "../..")

/** A row field that says which repository a row is of: a row with one is never the person's own. */
const REPOSITORY_FIELDS = ["repoId", "repo", "repository", "owner"]

/** What reads a collection's rows. */
const READS = new Set(["tanstack", "toArray", "rows", "changes", "get"])

/** A store's own modules: they keep and write raw rows, and expose them only through the gate. */
const STORE_SIDE = /^src\/features\/[^/]+\/(store|actions|source|writes|queries|tab|comparison|shapeSync|publishActions|publishStore|owners|embed|steps|flows|gate)\.ts$/

/** Other modules that read a store's raw rows to act, never to show them, by why. */
const ACTS: Readonly<Record<string, string>> = {
  "src/resumeAdmissions.ts": "finishes the device's own queued writes after a reload; renders nothing",
  "src/admissionSource.ts": "admits the device's own queued writes; renders nothing",
  "src/features/timeline/notice.ts": "checks whether its own notice is already raised before it raises one",
  "src/features/attention/modelNotice.ts": "checks whether the model notice is already raised before it raises or drops it",
  "src/features/conversations/pin.ts": "names the routed branch in a pin's payload; renders nothing",
  "src/features/pulls/refresh.ts": "adds the routed pull request's number to its shape's request; renders nothing",
  "src/features/views/minimize.ts": "reads where a minimized view came from, to go back there; renders nothing",
  "src/features/chat/chat.ts": "Pin's action reads the person's pin state and the routed conversation's messages to name what it pins; every query it hands a page is the store's gated one",
  "src/features/chat/shortcuts.ts": "reads the composer's draft to act on a key; renders nothing",
  "src/features/views/embeds.ts": "follows which conversation is routed, to open its embeds; renders nothing",
  "src/features/runs/steers.ts": "reads the person's own queued steers to send or drop one; renders nothing",
  "src/features/code-intel/codeIntel.ts": "reads the editor's own hover state to answer a key; renders nothing",
}

/**
 * Raw collections modules outside the stores read, by the field that names them, because their rows are the person's
 * own: each row type is checked to name no repository.
 */
const PERSONAL: Readonly<Record<string, string>> = {
  session: "who is signed in on this tab",
  confirmed: "the last session the server confirmed",
  drafts: "the person's own unsent text, by draft key",
  views: "which plugin views this tab shows and each one's strip state: the tab's own UI",
  shown: "the plugin view this tab shows: the tab's own UI",
  sending: "the person's own steers of their runs, queued on this device",
  sent: "the person's own steers of their runs, sent from this device",
}

/** The row type of a raw collection, or none for anything else (a live query, the gate's queries, a plain value). */
const rawRowOf = (checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined => {
  const insert = checker.getPropertyOfType(type, "insert")
  if (insert === undefined || checker.getPropertyOfType(type, "tanstack") === undefined && checker.getPropertyOfType(type, "utils") === undefined) return undefined
  // A TanStack live query has `insert` too; its utils move its window.
  const utils = checker.getPropertyOfType(type, "utils")
  if (utils !== undefined && checker.getPropertyOfType(checker.getTypeOfSymbol(utils), "setWindow") !== undefined) return undefined
  const signature = checker.getTypeOfSymbol(insert).getCallSignatures()[0]
  const parameter = signature?.getParameters()[0]
  if (parameter === undefined) return undefined
  const input = checker.getTypeOfSymbol(parameter)
  const rows = input.isUnion() ? input.types : [input]
  return rows.find((row) => !checker.isArrayType(row) && !checker.isTupleType(row) && checker.getPropertyOfType(row, "length") === undefined)
}

const namesRepository = (checker: ts.TypeChecker, row: ts.Type) =>
  REPOSITORY_FIELDS.filter((field) => checker.getPropertyOfType(row, field) !== undefined)

test("outside the stores, nothing reads a raw collection of a repository's rows", () => {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(ROOT, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    },
  })!
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  const checker = program.getTypeChecker()
  const leaks: Array<string> = []
  const personal: Array<string> = []
  let reads = 0
  for (const file of program.getSourceFiles()) {
    const path = relative(ROOT, file.fileName)
    if (path.startsWith("..") || path.includes("node_modules") || /\.test\.tsx?$/.test(path) || path.startsWith("src/test/")) continue
    if (!path.startsWith("src/") && !path.startsWith("plugins/")) continue
    if (STORE_SIDE.test(path) || ACTS[path] !== undefined) continue
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && READS.has(node.name.text)) {
        const row = rawRowOf(checker, checker.getTypeAtLocation(node.expression))
        if (row !== undefined) {
          reads++
          const where = `${path}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.getText()}`
          const fields = namesRepository(checker, row)
          const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
            : ts.isIdentifier(node.expression) ? node.expression.text : ""
          if (fields.length > 0) leaks.push(`${where} (rows name ${fields.join(", ")})`)
          else if (PERSONAL[name] === undefined) personal.push(`${where} (undeclared: rows of no repository read raw)`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  expect(reads).toBeGreaterThan(0)
  expect(leaks, leaks.join("\n")).toEqual([])
  expect(personal, personal.join("\n")).toEqual([])
}, 240_000)

test("the walk finds a component that reads a raw collection of a repository's rows", () => {
  const source = `
    interface Collection<A> { readonly tanstack: { readonly toArray: Array<A> }; readonly insert: (rows: A | ReadonlyArray<A>) => void }
    interface Gated<A> { readonly tanstack: { readonly toArray: Array<A> } }
    declare const raw: Collection<{ readonly id: string; readonly repoId: string }>
    declare const shown: Gated<{ readonly id: string; readonly repoId: string }>
    declare const mine: Collection<{ readonly id: string; readonly body: string }>
    export const a = raw.tanstack
    export const b = shown.tanstack
    export const c = mine.tanstack
  `
  const host = ts.createCompilerHost({})
  const original = host.getSourceFile
  host.getSourceFile = (name, version) =>
    name === "/probe.ts" ? ts.createSourceFile(name, source, version) : original.call(host, name, version)
  const program = ts.createProgram({ rootNames: ["/probe.ts"], options: { strict: true }, host })
  const checker = program.getTypeChecker()
  const found: Array<string> = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "tanstack") {
      const row = rawRowOf(checker, checker.getTypeAtLocation(node.expression))
      if (row !== undefined) found.push(`${node.expression.getText()}:${namesRepository(checker, row).join(",")}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(program.getSourceFile("/probe.ts")!)
  expect(found).toEqual(["raw:repoId", "mine:"])
})
