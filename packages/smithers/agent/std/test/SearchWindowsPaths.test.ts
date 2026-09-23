import { NodeServices } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Path from "@smthrs/kernel/Path"
import { Context, Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, win32 } from "node:path"
import { expect, it } from "vitest"
import * as Glob from "../src/Glob.ts"
import * as Grep from "../src/Grep.ts"
import * as PortableSearch from "../src/PortableSearch.ts"
import * as Search from "../src/Search.ts"

it.each([
  {
    name: "nested globs and anchored ignores",
    pattern: "src/**/*.ts",
    rules: "src/**/drop.ts\n",
    files: ["src/drop.ts", "src/nested/drop.ts", "src/keep.ts", "other/keep.ts"],
    kept: ["src/keep.ts"]
  },
  {
    name: "path negation",
    pattern: "**/*.tmp",
    rules: "*.tmp\n!src/keep.tmp\n",
    files: ["src/drop.tmp", "src/keep.tmp", "other/keep.tmp"],
    kept: ["src/keep.tmp"]
  },
  {
    name: "directory negation",
    pattern: "**/*",
    rules: "*\n!src/\n!src/keep.ts\n",
    files: ["src/drop.ts", "src/keep.ts", "other/keep.ts"],
    kept: ["src/keep.ts"]
  }
])("matches $name through a Windows path service", async (scenario) => {
  const nativeRoot = mkdtempSync(join(tmpdir(), "std-windows-search-"))
  const root = "C:\\search"
  const native = (value: string) => join(nativeRoot, ...win32.relative(root, value).split("\\"))
  try {
    writeFileSync(join(nativeRoot, ".gitignore"), scenario.rules)
    for (const file of scenario.files) {
      const target = join(nativeRoot, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, "needle\n")
    }
    const search = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        // Keep real filesystem reads while exercising Win32 path conventions
        // on every CI host. Results retain the service's native path spelling.
        const mapped: FileSystem.FileSystem = {
          ...fs,
          stat: (value) => fs.stat(native(value)),
          readDirectory: (value) => fs.readDirectory(native(value)),
          readLink: (value) => fs.readLink(native(value)),
          readFile: (value) => fs.readFile(native(value)),
          readFileString: (value, encoding) => fs.readFileString(native(value), encoding),
          stream: (value, options) => fs.stream(native(value), options)
        }
        return PortableSearch.make(Context.make(FileSystem.FileSystem, mapped).pipe(Context.add(Path.Path, path)))
      }).pipe(Effect.provide(NodePath.layerWin32), Effect.provide(NodeServices.layer))
    )
    const glob = await Effect.runPromise(
      Glob.run({ root, pattern: scenario.pattern }).pipe(Effect.provideService(Search.Search, search))
    )
    const expected = scenario.kept.map((file) => win32.join(root, file))
    expect(glob.paths).toEqual(expected)
    const grep = await Effect.runPromise(
      Grep.run({ root, pattern: "needle", globs: [scenario.pattern], symbols: false }).pipe(
        Effect.provideService(Search.Search, search)
      )
    )
    expect(grep.matches.map((match) => match.file)).toEqual(expected)
    expect(grep.filesSearched).toBe(expected.length)
  } finally {
    rmSync(nativeRoot, { recursive: true, force: true })
  }
})
