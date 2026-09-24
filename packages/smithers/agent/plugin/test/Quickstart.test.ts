import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"
import { expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

it("typechecks the quickstart snippets in the files the guide names", () => {
  const guide = readFileSync(join(packageRoot, "docs/quickstart.md"), "utf8")
  const files = new Map<string, string>()
  let currentFile: string | undefined
  for (const match of guide.matchAll(/Create `(\w+\.ts)`[^\n]*:|```ts\n([\s\S]*?)```/g)) {
    if (match[1]) {
      currentFile = match[1]
    } else {
      expect(currentFile, "Every snippet must belong to a named file").toBeDefined()
      files.set(currentFile!, `${files.get(currentFile!) ?? ""}${match[2]}\n`)
    }
  }

  const temporaryRoot = mkdtempSync(join(packageRoot, "node_modules/.quickstart-"))
  try {
    writeFileSync(join(temporaryRoot, "package.json"), "{\"type\":\"module\"}\n")
    for (const [name, source] of files) writeFileSync(join(temporaryRoot, name), source)
    const program = ts.createProgram([...files.keys()].map((name) => join(temporaryRoot, name)), {
      target: ts.ScriptTarget.ES2022,
      // The source fallback is checked with the same libraries as the package.
      lib: ["lib.es2022.d.ts", "lib.es2024.string.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      types: [],
      // Always the source: a dist left over from an earlier build would check
      // the guide against an API the package no longer has.
      paths: { "@smthrs/plugin": [join(packageRoot, "src/index.ts")] }
    })
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    )
    expect(diagnostics).toEqual([])
    expect([...files.keys()]).toEqual(["host.ts", "main.ts"])
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
  // A whole TypeScript program over the package source: tens of seconds on a
  // loaded machine, and past the suite's 30 s default.
}, 180_000)
