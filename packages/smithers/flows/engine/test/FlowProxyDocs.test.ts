import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { normalize } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

// Compile the published snippets themselves so an API change cannot leave a
// separately maintained example green while the copy readers use is broken.
const examples = [...read("../src/FlowProxy.ts").matchAll(/ \* ```ts\n([\s\S]*?) \* ```/g)]
  .map((match) => match[1]!.replace(/^ \* ?/gm, ""))

// One program compiles every example: each program re-checks the imported
// source graph, so a program per example doubled the cost of the slowest
// file in this suite under coverage on a loaded worker.
const exampleFile = (index: number) => fileURLToPath(new URL(`./proxy-doc-example-${index}.ts`, import.meta.url))
const key = (name: string) => normalize(name).toLowerCase()

let compiled: ReadonlyArray<string> | undefined
const diagnostics = (): ReadonlyArray<string> => {
  if (compiled !== undefined) return compiled
  const files = examples.map((_, index) => exampleFile(index))
  const sources = new Map(files.map((file, index) => [key(file), examples[index]!]))
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    types: ["node"]
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = sources.get(key(name))
    return source === undefined
      ? getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(name, source, languageVersion, true)
  }
  const fileExists = host.fileExists.bind(host)
  host.fileExists = (name) => sources.has(key(name)) || fileExists(name)
  const program = ts.createProgram(files, options, host)
  const format = (found: ReadonlyArray<ts.Diagnostic>) =>
    ts.formatDiagnostics(found, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n"
    })
  // Scoped to one example, pre-emit diagnostics still include the options
  // and global ones, so a broken shared graph fails every example.
  compiled = files.map((file) => format(ts.getPreEmitDiagnostics(program, program.getSourceFile(file))))
  return compiled
}

describe("FlowProxy documentation", () => {
  it("publishes both transport examples", () => {
    expect(examples).toHaveLength(2)
  })

  it.each(examples.map((_, index) => index))("typechecks transport example %#", (index) => {
    expect(diagnostics()[index]).toBe("")
  }, 120_000)

  it("distinguishes required wire ids from the fresh library default", () => {
    const vendor = read("../VENDOR.md").replace(/\s+/g, " ")
    expect(vendor).toContain("{ payload, executionId }")
    expect(vendor).not.toContain("{ payload, executionId? }")
    expect(vendor).toContain("fresh UUID")
    expect(vendor).not.toContain("default source dies")
  })

  it("does not claim the define-and-run example requires an explicit id", () => {
    const example = read("../../../../../examples/src/01-define-and-run.ts")
    expect(example).not.toContain("an explicit id is required")
    expect(example).toContain("fresh UUID")
  })
})
