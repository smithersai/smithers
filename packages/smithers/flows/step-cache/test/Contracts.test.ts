import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, posix, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import * as CacheStore from "../src/CacheStore.vibe"
import * as Root from "../src/index.ts"

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url))

/** A source module: TypeScript, or the same module migrated to VibeLang. */
const sourceExtensions = [".ts", ".vibe"] as const

/** A source module's file, and not the declaration sidecar a `.vibe` module may emit. */
const isSourceFile = (file: string): boolean =>
  sourceExtensions.some((extension) => file.endsWith(extension)) && !file.endsWith(".d.vibe.ts")

/** A module's path without its source extension, so a module keeps its name across the migration. */
const stem = (file: string): string => {
  const extension = sourceExtensions.find((extension) => file.endsWith(extension))
  return extension === undefined ? file : file.slice(0, -extension.length)
}

/** The one file, among the paths `exists` accepts, that holds the module `name`. */
const sourceFile = (exists: (file: string) => boolean, name: string): string => {
  const found = sourceExtensions.map((extension) => `${name}${extension}`).filter(exists)
  if (found.length !== 1) {
    throw new Error(`${name} needs one source module, found ${found.length === 0 ? "none" : found.join(" and ")}`)
  }
  return found[0]!
}

/** The file under `src/` that holds the module `name`. */
const moduleFile = (name: string): string => sourceFile((file) => existsSync(join(sourceRoot, file)), name)

/** Every module under `src/`, as a path relative to it. */
const modules = (directory = sourceRoot): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? modules(join(directory, entry.name))
      : isSourceFile(entry.name)
      ? [relative(sourceRoot, join(directory, entry.name)).split(sep).join("/")]
      : []
  )

/**
 * What a module loads at runtime: every import and re-export that is not
 * type-only, with relative specifiers resolved to module paths under `src/`.
 */
const runtimeImports = (module: string): ReadonlyArray<string> =>
  ts.createSourceFile(module, readFileSync(join(sourceRoot, module), "utf8"), ts.ScriptTarget.Latest).statements
    .flatMap((statement) => {
      const loaded = (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly !== true) ||
        (ts.isExportDeclaration(statement) && !statement.isTypeOnly)
      const specifier = loaded ? statement.moduleSpecifier : undefined
      if (specifier === undefined || !ts.isStringLiteral(specifier)) return []
      return [specifier.text.startsWith(".") ? posix.join(posix.dirname(module), specifier.text) : specifier.text]
    })

/** Every module and package a module loads at runtime, transitively. */
const closure = (module: string): ReadonlySet<string> => {
  const seen = new Set<string>()
  const visit = (next: string) => {
    for (const loaded of runtimeImports(next)) {
      if (seen.has(loaded)) continue
      seen.add(loaded)
      if (isSourceFile(loaded)) visit(loaded)
    }
  }
  visit(module)
  return seen
}

/** The SQL client and the transaction writer: what issuing a statement takes. */
const isSqlStack = (specifier: string): boolean =>
  specifier.startsWith("effect/sql/") || specifier === "@smthrs/database/DurableWriter"

describe("service contracts", () => {
  it.effect("constructs and exercises the CacheStore stub", () =>
    Effect.gen(function*() {
      const service = CacheStore.makeNoop()
      const entry: CacheStore.CacheEntry = {
        keyDigest: "digest",
        result: {},
        meta: {},
        createdAtMs: 0,
        recordedRunId: "run",
        recordedEventSeq: 0
      }
      expect((yield* (Effect.flip(service.get("digest")))).message).toContain("get")
      expect((yield* (Effect.flip(service.put(entry)))).message).toContain("put")
      expect((yield* (Effect.flip(service.evict("digest")))).message).toContain("evict")
      expect((yield* (Effect.flip(service.sweepExpired(0)))).message).toContain("sweepExpired")

      const result = yield* (
        Effect.gen(function*() {
          return yield* (yield* CacheStore.CacheStore).get("digest")
        }).pipe(
          Effect.provide(CacheStore.layerNoop({
            get: () => Effect.succeed(Option.none())
          }))
        )
      )
      expect(Option.isNone(result)).toBe(true)
    }))
})

describe("CacheStore public surface", () => {
  // The SQL implementation, the entry model, and the admission policy live
  // under `internal/`; this subpath and the root namespace re-export them, so
  // no consumer import changes when a definition moves.
  const values = [
    "CacheEntry",
    "CacheStore",
    "CacheStoreError",
    "CacheStoreErrorCode",
    "KeyDigest",
    "RecordedBy",
    "RecordedRunId",
    "encodeCanonical",
    "encodeEntryCanonical",
    "layer",
    "layerNoop",
    "make",
    "makeNoop",
    "maximumJsonBytes",
    "maximumJsonDepth",
    "maximumJsonMembers",
    "maximumJsonNodes",
    "maximumKeyDigestLength",
    "maximumRecordedRunIdLength",
    "rebuildHeads",
    "snapshotEntry",
    "validateAge",
    "validateFence",
    "validateKey",
    "validateRecordedBy"
  ]

  it("exports exactly its public values, from the subpath and the root", () => {
    expect(Object.keys(CacheStore).sort()).toEqual(values)
    expect(Object.keys(Root.CacheStore).sort()).toEqual(values)
    for (const name of values) {
      expect(Root.CacheStore[name as keyof typeof Root.CacheStore]).toBe(CacheStore[name as keyof typeof CacheStore])
    }
  })
})

/**
 * Every type the subpath exports. `tsconfig.test.json`
 * fails the package check when one of them stops resolving from it.
 */
export type PublicTypes = [
  CacheStore.CacheEntry,
  CacheStore.CacheStoreErrorCode,
  CacheStore.EvictOptions,
  CacheStore.GetOptions,
  CacheStore.KeyDigest,
  CacheStore.PutResult,
  CacheStore.RecordedRef,
  CacheStore.RecordedBy,
  CacheStore.Service,
  CacheStore.SweepOptions
]

describe("module layout", () => {
  it("confines the SQL client and the transaction writer to the SQL tier and its migration", () => {
    // While the service module also issued the SQL, the HTTP tier took its
    // input boundary from the module that owned the SQL tier, and a schema,
    // admission, or SQL change all edited that one file. The barrel is the
    // SQL tier's only importer, so the tiers depend on the contract instead.
    expect(modules().filter((module) => runtimeImports(module).some(isSqlStack)).map(stem).sort()).toEqual([
      "internal/SqlCacheStore",
      "migrations/0001_initial",
      "migrations/0002_created_at_index"
    ])
    expect(
      modules().filter((module) => runtimeImports(module).map(stem).includes("internal/SqlCacheStore")).map(stem)
    ).toEqual([
      "CacheStore"
    ])
  })

  it("keeps the shared admission policy free of every tier", () => {
    const loaded = [...closure(moduleFile("internal/CacheAdmission"))]
    expect(loaded.filter(isSourceFile).map(stem).sort()).toEqual([
      "internal/CacheEntry",
      "internal/CacheStoreError"
    ])
    expect(loaded.filter(isSqlStack)).toEqual([])
  })

  it.each([
    ["a .ts module", ["M.ts"], "M.ts"],
    ["a .vibe module", ["M.vibe"], "M.vibe"]
  ])("finds %s", (_case, files, expected) => {
    expect(sourceFile((file) => files.includes(file), "M")).toBe(expected)
  })

  it.each([
    ["a missing module", ["Other.ts"], "none"],
    ["a module in both languages", ["M.ts", "M.vibe"], "M.ts and M.vibe"],
    ["a declaration sidecar only", ["M.d.vibe.ts"], "none"],
    ["a module in another language", ["M.js"], "none"]
  ])("refuses %s", (_case, files, found) => {
    expect(() => sourceFile((file) => files.includes(file), "M")).toThrow(`M needs one source module, found ${found}`)
  })

  it.each([
    ["internal/M.ts", true, "internal/M"],
    ["internal/M.vibe", true, "internal/M"],
    ["internal/M.d.vibe.ts", false, "internal/M.d.vibe"],
    ["internal/M.js", false, "internal/M.js"],
    ["effect/sql/SqlClient", false, "effect/sql/SqlClient"]
  ])("reads %s as a source file: %s, module %s", (file, source, name) => {
    expect(isSourceFile(file)).toBe(source)
    expect(stem(file)).toBe(name)
  })
})
