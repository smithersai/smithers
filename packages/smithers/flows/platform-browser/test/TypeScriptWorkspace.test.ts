/** Regressions against the real TypeScript compiler and injected workspace reads. */
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import ts from "typescript"
import * as Workspace from "../src/internal/TypeScriptWorkspace.ts"

const make = (files: Record<string, string>, limits?: Workspace.Limits) =>
  Workspace.make(ts, Object.keys(files), {
    read: (paths) => Effect.succeed(paths.map((path) => [path, files[path] ?? null] as const)),
    lib: () => Effect.succeed(undefined)
  }, limits)
const position = { line: 1, character: 0 }
const main = "import { value } from \"./value\"\nvalue"

describe("TypeScript workspace regressions", () => {
  it("clamps oversized columns before every kind of line break", () => {
    for (const newline of ["\n", "\r", "\r\n"]) {
      const text = `abc${newline}value`
      expect(Workspace.offsetAt(text, Workspace.lineStarts(text), { line: 0, character: 999 })).toBe(3)
    }
  })

  it.effect("refuses a file larger than the size budget left", () =>
    Effect.gen(function*() {
      const workspace = make({ "/main.ts": "export const value = 1" }, { files: 10, bytes: 1 })
      const failure = yield* Effect.flip(workspace.documentSymbols("/main.ts"))
      expect(failure.code).toBe("response_too_large")
      expect(workspace.loaded()).toEqual({ files: 0, partial: true })
    }))

  it.effect("keeps one widening within the size limit", () =>
    Effect.gen(function*() {
      const text = `export const value = 1\n${"// padding\n".repeat(600)}`
      const files: Record<string, string> = {}
      for (let index = 0; index < 300; index++) files[`/f${index}.ts`] = text
      const reads: Array<number> = []
      const workspace = Workspace.make(ts, Object.keys(files), {
        read: (paths) =>
          Effect.sync(() => {
            reads.push(paths.length)
            return paths.map((path) => [path, files[path]!] as const)
          }),
        lib: () => Effect.succeed(undefined)
      }, { files: 2000, bytes: 10_000 })
      yield* workspace.references("/f0.ts", { line: 0, character: 13 })
      expect(workspace.loaded()).toEqual({ files: Math.floor(10_000 / text.length), partial: true })
      expect(reads.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(1 + 32)
    }))

  it.effect("keeps the files an interrupted load read", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      let block = true
      const files: Record<string, string> = {
        "/a.ts": "import { b } from \"./b\"\nexport const a = b",
        "/b.ts": "import { c } from \"./c\"\nexport const b = c",
        "/c.ts": "export const c = 1"
      }
      const reads: Array<ReadonlyArray<string>> = []
      const workspace = Workspace.make(ts, Object.keys(files), {
        lib: () => Effect.succeed(undefined),
        read: (paths) =>
          Effect.gen(function*() {
            reads.push(paths)
            if (block && paths.includes("/c.ts")) {
              yield* Deferred.succeed(entered, undefined)
              return yield* Effect.never
            }
            return paths.map((path) => [path, files[path] ?? null] as const)
          })
      })
      const request = yield* Effect.forkChild(workspace.documentSymbols("/a.ts"))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(request)
      block = false
      yield* workspace.documentSymbols("/a.ts")
      expect(reads).toEqual([["/a.ts"], ["/b.ts"], ["/c.ts"], ["/c.ts"]])
      expect(workspace.loaded()).toEqual({ files: 3, partial: false })
    }).pipe(Effect.scoped))

  it.effect("loads imports added by an overlay, including new files", () =>
    Effect.gen(function*() {
      const workspace = make({ "/main.ts": "export {}", "/value.ts": "export const value = 42" })
      yield* workspace.documentSymbols("/main.ts")
      for (const path of ["/main.ts", "/new.ts"]) {
        yield* workspace.sync(path, main)
        expect(yield* workspace.definition(path, position)).toMatchObject([{ uri: "file:///value.ts" }])
      }
    }))

  it.effect("resolves edited imports into a newly created overlay directory", () =>
    Effect.gen(function*() {
      const workspace = make({ "/src/main.ts": "export {}" })
      yield* workspace.documentSymbols("/src/main.ts")
      yield* workspace.sync("/src/new/value.ts", "export const value = 42")
      yield* workspace.sync("/src/main.ts", main.replace("./value", "./new/value"))
      expect(yield* workspace.definition("/src/main.ts", position)).toMatchObject([{ uri: "file:///src/new/value.ts" }])
      yield* workspace.close("/src/new/value.ts")
      expect(yield* workspace.definition("/src/main.ts", position)).not.toMatchObject([{
        uri: "file:///src/new/value.ts"
      }])
    }))

  it.effect("resumes widening after the first references request is interrupted", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      let block = true
      const files: Record<string, string> = {
        "/value.ts": "export const value = 42",
        "/main.ts": main
      }
      const workspace = Workspace.make(ts, Object.keys(files), {
        lib: () => Effect.succeed(undefined),
        read: (paths) =>
          Effect.gen(function*() {
            if (block && paths.includes("/main.ts")) {
              yield* Deferred.succeed(entered, undefined)
              return yield* Effect.never
            }
            return paths.map((path) => [path, files[path] ?? null] as const)
          })
      })
      const request = yield* Effect.forkChild(workspace.references("/value.ts", { line: 0, character: 13 }))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(request)
      block = false
      expect(yield* workspace.references("/value.ts", { line: 0, character: 13 })).toMatchObject([
        { uri: "file:///value.ts" },
        { uri: "file:///main.ts" },
        { uri: "file:///main.ts" }
      ])
    }).pipe(Effect.scoped))

  it.effect("resumes import discovery canceled after script text was cached", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      let block = true
      const files: Record<string, string> = {
        "/pkg/value.ts": "export const value = 42",
        "/pkg/main.ts": main.replace("./value", "#value"),
        "/pkg/package.json": JSON.stringify({ imports: { "#value": "./value.ts" } })
      }
      const workspace = Workspace.make(ts, Object.keys(files), {
        lib: () => Effect.succeed(undefined),
        read: (paths) =>
          Effect.gen(function*() {
            if (block && paths.includes("/pkg/package.json")) {
              yield* Deferred.succeed(entered, undefined)
              return yield* Effect.never
            }
            return paths.map((path) => [path, files[path] ?? null] as const)
          })
      })
      const request = yield* Effect.forkChild(workspace.references("/pkg/value.ts", { line: 0, character: 13 }))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(request)
      block = false
      expect(yield* workspace.references("/pkg/value.ts", { line: 0, character: 13 })).toMatchObject([
        { uri: "file:///pkg/value.ts" },
        { uri: "file:///pkg/main.ts" },
        { uri: "file:///pkg/main.ts" }
      ])
    }).pipe(Effect.scoped))

  it.effect("resolves paths without baseUrl relative to their declaring config", () =>
    Effect.gen(function*() {
      const workspace = make({
        "/repo/base/tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["lib/*"] } } }),
        "/repo/app/tsconfig.json": JSON.stringify({ extends: "../base/tsconfig.json" }),
        "/repo/base/lib/value.ts": "export const value = 42",
        "/repo/app/main.ts": main.replace("./value", "@lib/value")
      })
      expect(yield* workspace.definition("/repo/app/main.ts", position)).toMatchObject([
        { uri: "file:///repo/base/lib/value.ts" }
      ])
    }))

  it.effect("reserves admitted batch slots before loading package metadata", () =>
    Effect.gen(function*() {
      const workspace = make({
        "/main.ts": "import { a } from \"./pkg/a\"; import { b } from \"./pkg/b\"; export { a, b }",
        "/pkg/a.ts": "import { b } from \"#value\"; export const a = b",
        "/pkg/b.ts": "export const b = 1",
        "/pkg/package.json": JSON.stringify({ imports: { "#value": "./b.ts" } })
      }, { files: 3, bytes: 10000 })
      yield* workspace.documentSymbols("/main.ts")
      expect(workspace.loaded()).toEqual({ files: 3, partial: true })
    }))

  it.effect("reports partial resolution when the manifest cannot fit in the workspace", () =>
    Effect.gen(function*() {
      const workspace = make({
        "/pkg/main.ts": main.replace("./value", "#value"),
        "/pkg/package.json": JSON.stringify({ imports: { "#value": "./value.ts" } }),
        "/pkg/value.ts": "export const value = 42"
      }, { files: 1, bytes: 10000 })
      const result = yield* workspace.definition("/pkg/main.ts", position)
      expect(result).toMatchObject([{ uri: "file:///pkg/main.ts" }])
      expect(workspace.loaded()).toEqual({ files: 1, partial: true })
    }))

  for (const specifier of ["pkg/value", "#value"]) {
    it.effect(`loads package metadata for ${specifier}`, () =>
      Effect.gen(function*() {
        const workspace = make({
          "/pkg/package.json": JSON.stringify({
            name: "pkg",
            type: "module",
            exports: { "./value": "./value.ts" },
            imports: { "#value": "./value.ts" }
          }),
          "/pkg/main.ts": main.replace("./value", specifier),
          "/pkg/value.ts": "export const value = 42"
        })
        expect(yield* workspace.definition("/pkg/main.ts", position)).toMatchObject([{ uri: "file:///pkg/value.ts" }])
      }))
  }
})
