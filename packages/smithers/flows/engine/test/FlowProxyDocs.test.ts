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

describe("FlowProxy documentation", () => {
  it("publishes both transport examples", () => {
    expect(examples).toHaveLength(2)
  })

  // Each compiler checks the imported source graph too; allow for coverage
  // instrumentation on shared CI workers while retaining a finite bound.
  it.each(examples)("typechecks transport example %#", (source) => {
    const file = fileURLToPath(new URL("./proxy-doc-example.ts", import.meta.url))
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
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
      normalize(name).toLowerCase() === normalize(file).toLowerCase()
        ? ts.createSourceFile(name, source, languageVersion, true)
        : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
    const fileExists = host.fileExists.bind(host)
    host.fileExists = (name) => normalize(name).toLowerCase() === normalize(file).toLowerCase() || fileExists(name)
    const program = ts.createProgram([file], options, host)
    const diagnostics = ts.getPreEmitDiagnostics(program)
    expect(ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n"
    })).toBe("")
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
