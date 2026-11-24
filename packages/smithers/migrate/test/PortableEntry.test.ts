/**
 * `import "@smthrs/migrate"` loads no SQLite engine and no host path module.
 *
 * The root entry is what a browser or a Worker resolves. This walks the module
 * graph it loads, through every `import`, `export ... from`, `require`, and
 * `import()` that survives type erasure, and pins the host modules in it.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { existsSync, readFileSync } from "node:fs"
import { isBuiltin } from "node:module"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Ts from "../src/internal/Ts.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))

/** Each module reachable from `entry`, with the bare specifiers it loads at run time. */
const graph = (entry: string) =>
  Effect.gen(function*() {
    const parse = yield* Ts.session
    const reached = new Map<string, ReadonlyArray<string>>()
    const pending = [resolve(packageRoot, entry)]
    while (pending.length > 0) {
      const file = pending.pop()!
      const name = relative(packageRoot, file).replaceAll("\\", "/")
      if (reached.has(name)) continue
      const source = parse(file, readFileSync(file, "utf8"))
      // `import type` and `export type` are erased; everything else loads.
      const erased = new Set(Ts.imports(source).filter((record) => record.typeOnly).map((record) => record.line))
      const bare: Array<string> = []
      for (const record of Ts.moduleSpecifiers(source)) {
        if (erased.has(record.line)) continue
        if (!record.specifier.startsWith(".")) {
          bare.push(record.specifier)
          continue
        }
        const target = resolve(dirname(file), record.specifier)
        expect(existsSync(target), `${name} imports ${record.specifier}`).toBe(true)
        pending.push(target)
      }
      reached.set(name, bare)
    }
    return reached
  }).pipe(Effect.scoped)

const hostModules = (reached: ReadonlyMap<string, ReadonlyArray<string>>): ReadonlyArray<string> =>
  [...reached].flatMap(([file, specifiers]) =>
    specifiers.filter((specifier) => specifier.startsWith("bun") || isBuiltin(specifier)).map((specifier) =>
      `${file} -> ${specifier}`
    )
  ).sort()

describe("the root entry's import graph", () => {
  it.effect("reaches the scanners and the SQLite seam, and neither node:sqlite nor node:path", () =>
    Effect.gen(function*() {
      const reached = yield* graph("src/index.ts")
      // The walk is not vacuous: it reaches the modules that used to load them.
      for (const file of ["src/RunState.ts", "src/Scan.ts", "src/SqliteStore.ts", "src/flow/Options.ts"]) {
        expect([...reached.keys()], file).toContain(file)
      }
      expect([...reached.keys()]).not.toContain("src/SqliteStoreNode.ts")
      const specifiers = [...reached.values()].flat()
      for (const forbidden of ["node:sqlite", "sqlite", "node:path", "path", "bun:sqlite"]) {
        expect(specifiers, forbidden).not.toContain(forbidden)
      }
      // Every host module the root entry still loads. A new one fails here.
      expect(hostModules(reached)).toEqual(["src/Checks.ts -> node:crypto"])
    }))

  it.effect("finds node:sqlite in the Node engine and in the composition that provides it", () =>
    Effect.gen(function*() {
      expect(hostModules(yield* graph("src/SqliteStoreNode.ts"))).toEqual(["src/SqliteStoreNode.ts -> node:sqlite"])
      expect(hostModules(yield* graph("src/flow/Layers.ts"))).toContain("src/SqliteStoreNode.ts -> node:sqlite")
    }))

  it.effect("keeps node:sqlite out of the apply lock, which takes its lock from the seam", () =>
    Effect.gen(function*() {
      const specifiers = [...(yield* graph("src/flow/Lock.ts")).values()].flat()
      expect(specifiers).not.toContain("node:sqlite")
    }))
})
