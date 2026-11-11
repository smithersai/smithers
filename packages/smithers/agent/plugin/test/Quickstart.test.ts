import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { compileProjectSync } from "vibelang/project"
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
    // The VibeLang checker, since the package source is .vibe modules that a
    // stock TypeScript program cannot read.
    writeFileSync(
      join(temporaryRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2022",
          // The source fallback is checked with the same libraries as the package.
          lib: ["es2022", "es2024.string", "dom", "dom.iterable"],
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          types: [],
          // Always the source: a dist left over from an earlier build would check
          // the guide against an API the package no longer has.
          paths: { "@smthrs/plugin": [join(packageRoot, "src/index.vibe")] }
        },
        files: [...files.keys()]
      })
    )
    const diagnostics = compileProjectSync({ project: join(temporaryRoot, "tsconfig.json"), root: packageRoot, cache: false })
      .errors.map((diagnostic) => diagnostic.text)
    expect(diagnostics).toEqual([])
    expect([...files.keys()]).toEqual(["host.ts", "main.ts"])
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
  // A whole TypeScript program over the package source: tens of seconds on a
  // loaded machine, and past the suite's 30 s default.
}, 180_000)
