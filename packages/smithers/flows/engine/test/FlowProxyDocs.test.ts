import { describe, expect, it } from "@effect/vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { compileProjectSync, formatDiagnostic } from "vibelang/project"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

// Compile the published snippets themselves so an API change cannot leave a
// separately maintained example green while the copy readers use is broken.
const examples = [...read("../src/FlowProxy.ts").matchAll(/ \* ```ts\n([\s\S]*?) \* ```/g)]
  .map((match) => match[1]!.replace(/^ \* ?/gm, ""))

// One program compiles every example: each program re-checks the imported
// source graph, so a program per example doubled the cost of the slowest
// file in this suite under coverage on a loaded worker. The VibeLang checker
// compiles it, since the packages the examples import are .vibe sources that
// a stock TypeScript program cannot read.
const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))

let compiled: ReadonlyArray<string> | undefined
const diagnostics = (): ReadonlyArray<string> => {
  if (compiled !== undefined) return compiled
  const directory = mkdtempSync(join(packageRoot, "test", ".proxy-doc-examples-"))
  try {
    const names = examples.map((_, index) => `proxy-doc-example-${index}.ts`)
    names.forEach((name, index) => writeFileSync(join(directory, name), examples[index]!))
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2022",
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          types: ["node"]
        },
        files: names
      })
    )
    const { errors } = compileProjectSync({
      project: join(directory, "tsconfig.json"),
      root: repositoryRoot,
      cache: false
    })
    // Scoped to one example, the options and global diagnostics still count,
    // so a broken shared graph fails every example.
    compiled = names.map((name) =>
      errors
        .filter((diagnostic) =>
          diagnostic.file === undefined || resolve(repositoryRoot, diagnostic.file) === join(directory, name)
        )
        .map(formatDiagnostic)
        .join("\n")
    )
    return compiled
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
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
    const example = read("../examples/01-define-and-run.vibe")
    expect(example).not.toContain("an explicit id is required")
    expect(example).toContain("fresh UUID")
  })
})
