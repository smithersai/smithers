/**
 * BrowserLanguageServer over the real TypeScript compiler API and TypeScript's
 * own lib files: the tab half (`make`) and the worker half (`program`, `serve`)
 * talk over a real `MessageChannel`, as a page and its dedicated worker do.
 * The workspace is a small project held in memory; its reads count, so a test
 * can say which files a request loaded. Unhappy paths inject a faulty worker,
 * a faulty compiler or a faulty read; every happy path runs the real ones.
 */
import { describe, expect, it } from "@effect/vitest"
import type { LanguageServer } from "@smthrs/std"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import type * as Scope from "effect/Scope"
import * as TestClock from "effect/testing/TestClock"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import ts from "typescript"
import { BrowserLanguageServer } from "../src/index.ts"
import * as TypeScriptWorkspace from "../src/internal/TypeScriptWorkspace.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

const libDirectory = dirname(createRequire(import.meta.url).resolve("typescript"))
const lib = (name: string) => readFile(join(libDirectory, name), "utf8").catch(() => undefined)

const PROJECT: Record<string, string | undefined> = {
  "tsconfig.json": `{
    // comments and trailing commas, as tsconfig allows
    "extends": ["./tsconfig.base", "@tsconfig/strictest/tsconfig.json"],
    "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] }, },
  }`,
  "tsconfig.base.json":
    `{ "extends": 7, "compilerOptions": { "strict": true, "lib": ["es2022"], "target": "es2022" } }`,
  "src/math.ts": [
    "/**",
    " * Adds two numbers.",
    " * @param a the first",
    " * @deprecated",
    " */",
    "export function add(a: number, b: number): number {",
    "  return a + b",
    "}",
    "export interface Shape { area(): number }",
    "export class Square implements Shape {",
    "  constructor(readonly side: number) {}",
    "  area() { return this.side * this.side }",
    "}",
    ""
  ].join("\n"),
  "src/main.ts": [
    "import { add, Square, type Shape } from \"./math\"",
    "import { twice } from \"@lib/twice\"",
    "import express from \"express\"",
    "const total: number = add(1, 2)",
    "const shape: Shape = new Square(2)",
    "export const result = twice(total) + shape.area()",
    "const wrong: string = 42",
    "export const methods = { add }",
    "// add is mentioned here",
    ""
  ].join("\r\n"),
  "src/lib/twice.ts":
    "/// <reference path=\"../../types/global.d.ts\" />\nexport const twice = (value: number): number => value * 2\n",
  "types/global.d.ts": "declare const VERSION: string\n",
  "src/other.ts": "import { add } from \"./math\"\nexport const four = add(2, 2)\n",
  "node_modules/vendored/index.ts": "export const vendored = 1\n",
  "src/empty.ts": "",
  "src/lazy.ts": "export const meta = import.meta\n",
  "assets/logo.png": undefined
}

interface Harness {
  readonly server: LanguageServer.LanguageServer
  /** Every path the worker asked the tab for, in order. */
  readonly reads: Array<string>
}

/** The worker's half on one end of a channel; the tab's `make` on the other, as its `Worker`. */
const connect = (
  files: Record<string, string | undefined>,
  options: {
    readonly typescript?: TypeScriptWorkspace.TypeScript
    readonly lib?: (name: string) => Promise<string | undefined>
    readonly limits?: Partial<TypeScriptWorkspace.Limits>
    readonly read?: (path: string) => Effect.Effect<string | undefined, unknown>
    readonly concurrency?: number
  } = {}
): Effect.Effect<Harness, never, Scope.Scope> =>
  Effect.gen(function*() {
    const channel = new MessageChannel()
    channel.port2.start()
    yield* Effect.forkScoped(BrowserLanguageServer.program({
      typescript: options.typescript ?? ts,
      lib: options.lib ?? lib,
      port: channel.port1 as unknown as BrowserLanguageServer.ServeOptions["port"] & object,
      limits: options.limits
    }))
    const reads: Array<string> = []
    const server = yield* BrowserLanguageServer.make({
      worker: () => ({
        postMessage: (message) => channel.port2.postMessage(message),
        terminate: () => channel.port2.close(),
        addEventListener: (type: "message" | "error", listener: (event: never) => void) => {
          if (type === "message") channel.port2.addEventListener("message", listener as never)
        }
      }),
      workspace: {
        paths: Object.keys(files),
        read: options.read ?? ((path) =>
          Effect.sync(() => {
            reads.push(path)
            return files[path]
          }))
      },
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency })
    })
    return { server, reads }
  })

const at = (path: string, line: number, character: number) => ({ path, line, character })

describe("BrowserLanguageServer", () => {
  it.live("answers subsequent requests after an unresolved workspace read times out", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const channel = new MessageChannel()
      channel.port2.start()
      yield* Effect.forkScoped(BrowserLanguageServer.program({ typescript: ts, lib, port: channel.port1 as never }))
      const server = yield* BrowserLanguageServer.make({
        worker: () => ({
          postMessage: (message) => channel.port2.postMessage(message),
          terminate: () => channel.port2.close(),
          addEventListener: (type: "message" | "error", listener: (event: never) => void) => {
            if (type === "message") {
              channel.port2.addEventListener("message", (event) => {
                listener(event as never)
                // A duplicate cancellation must not disrupt the tab's dispatcher.
                if (event.data._tag === "CancelRead") listener(event as never)
              })
            }
          }
        }),
        workspace: {
          paths: ["a.ts"],
          read: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, undefined))
            )
        },
        timeout: "1 second"
      })
      const first = yield* Effect.forkChild(Effect.flip(server.hover(at("/a.ts", 0, 0))))
      yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
      expect((yield* Fiber.join(first)).code).toBe("timeout")
      yield* server.sync("/b.ts", "export const b = 1")
      expect(yield* server.workspaceSymbols("b")).toEqual([])
      yield* Deferred.await(stopped).pipe(Effect.timeout("5 seconds"))
    }).pipe(Effect.scoped))

  it.effect("hover answers the signature and documentation as Markdown, with the symbol's range", () =>
    Effect.gen(function*() {
      const { server } = yield* connect(PROJECT, { concurrency: 1 })
      const hover = (yield* server.hover(at("/src/main.ts", 3, 23))) as {
        contents: { kind: string; value: string }
        range: unknown
      }
      expect(hover.contents.kind).toBe("markdown")
      expect(hover.contents.value).toBe(
        "```typescript\n(alias) add(a: number, b: number): number\nimport add\n```\n\nAdds two numbers.\n\n*@param* a the first\n\n*@deprecated*"
      )
      expect(hover.range).toEqual({ start: { line: 3, character: 22 }, end: { line: 3, character: 25 } })
      // Nothing to say about whitespace.
      expect(yield* server.hover(at("/src/main.ts", 9, 0))).toBeNull()
    }).pipe(Effect.scoped))

  it.effect("definition jumps across files, through tsconfig paths, and within a file; a comment has none", () =>
    Effect.gen(function*() {
      const { server } = yield* connect(PROJECT)
      expect(yield* server.definition(at("/src/main.ts", 3, 23))).toEqual([
        { uri: "file:///src/math.ts", range: { start: { line: 5, character: 16 }, end: { line: 5, character: 19 } } }
      ])
      expect(yield* server.definition(at("/src/main.ts", 5, 23))).toEqual([
        {
          uri: "file:///src/lib/twice.ts",
          range: { start: { line: 1, character: 13 }, end: { line: 1, character: 18 } }
        }
      ])
      expect(yield* server.definition(at("/src/main.ts", 5, 29))).toEqual([
        { uri: "file:///src/main.ts", range: { start: { line: 3, character: 6 }, end: { line: 3, character: 11 } } }
      ])
      expect(yield* server.definition(at("/src/main.ts", 8, 5))).toEqual([])
      // A global from TypeScript's own lib files is defined outside the workspace.
      const [first] = (yield* server.definition(at("/src/math.ts", 9, 26))) as Array<{ uri: string }>
      expect(first).toBeUndefined()
    }).pipe(Effect.scoped))

  it.effect("references widen the program to the project, once, and list each place once", () =>
    Effect.gen(function*() {
      const { reads, server } = yield* connect(PROJECT)
      yield* server.hover(at("/src/main.ts", 3, 23))
      expect(reads).not.toContain("src/other.ts")
      const references = (yield* server.references(at("/src/main.ts", 3, 23))) as Array<
        { uri: string; range: { start: { line: number } } }
      >
      expect(references.map((reference) => `${reference.uri}:${reference.range.start.line}`).sort()).toEqual([
        "file:///src/main.ts:0",
        "file:///src/main.ts:3",
        "file:///src/main.ts:7",
        "file:///src/math.ts:5",
        "file:///src/other.ts:0",
        "file:///src/other.ts:1"
      ])
      expect(reads).toContain("src/other.ts")
      expect(reads).not.toContain("node_modules/vendored/index.ts")
      const before = reads.length
      yield* server.references(at("/src/main.ts", 4, 6))
      expect(reads.length).toBe(before)
      expect(yield* server.references(at("/src/main.ts", 8, 5))).toEqual([])
    }).pipe(Effect.scoped))

  it.effect("implementation finds the class that implements an interface method", () =>
    Effect.gen(function*() {
      const { server } = yield* connect(PROJECT)
      expect(yield* server.implementation(at("/src/math.ts", 8, 25))).toEqual([
        { uri: "file:///src/math.ts", range: { start: { line: 11, character: 2 }, end: { line: 11, character: 6 } } }
      ])
      expect(yield* server.implementation(at("/src/math.ts", 0, 1))).toEqual([])
    }).pipe(Effect.scoped))

  it.effect("documentSymbols is the file's outline, without its imports; workspaceSymbols searches what is open", () =>
    Effect.gen(function*() {
      const { server } = yield* connect(PROJECT)
      const outline = (yield* server.documentSymbols("/src/math.ts")) as Array<
        { name: string; kind: number; children: Array<{ name: string; kind: number }> }
      >
      expect(outline.map((symbol) => [symbol.name, symbol.kind])).toEqual([["add", 12], ["Shape", 11], ["Square", 5]])
      expect(outline[2]!.children.map((symbol) => [symbol.name, symbol.kind])).toEqual([
        ["constructor", 9],
        ["area", 6],
        ["side", 7]
      ])
      const main = (yield* server.documentSymbols("/src/main.ts")) as Array<{ name: string }>
      expect(main.map((symbol) => symbol.name)).toEqual(["methods", "result", "shape", "total", "wrong"])
      const found = (yield* server.workspaceSymbols("Square")) as Array<
        { name: string; kind: number; location: unknown }
      >
      expect(found[0]).toEqual({
        name: "Square",
        kind: 5,
        containerName: "",
        location: {
          uri: "file:///src/math.ts",
          range: { start: { line: 9, character: 0 }, end: { line: 12, character: 1 } }
        }
      })
    }).pipe(Effect.scoped))

  it.effect("workspaceSymbols before any file is open finds nothing", () =>
    Effect.gen(function*() {
      const { server } = yield* connect(PROJECT)
      expect(yield* server.workspaceSymbols("add")).toEqual([])
    }).pipe(Effect.scoped))

  it.effect("diagnostics keep the file's own errors and leave out a package the commit doesn't hold", () =>
    Effect.gen(function*() {
      const { server } = yield* connect(PROJECT)
      const report = (yield* server.diagnostics("/src/main.ts")) as {
        kind: string
        items: Array<{ code: number; severity: number; source: string; message: string; range: unknown }>
      }
      expect(report.kind).toBe("full")
      expect(report.items).toEqual([
        {
          code: 2322,
          severity: 1,
          source: "ts",
          message: "Type 'number' is not assignable to type 'string'.",
          range: { start: { line: 6, character: 6 }, end: { line: 6, character: 11 } }
        }
      ])
    }).pipe(Effect.scoped))

  it.effect("sync shows an edit until close drops it; a file the commit lacks can be synced too", () =>
    Effect.gen(function*() {
      const { server } = yield* connect(PROJECT)
      yield* server.sync("/src/math.ts", "export const add = (a: string): string => a\n")
      const edited = (yield* server.hover(at("/src/main.ts", 3, 23))) as { contents: { value: string } }
      expect(edited.contents.value).toContain("add(a: string): string")
      yield* server.close("/src/math.ts")
      yield* server.close("/src/never-synced.ts")
      const restored = (yield* server.hover(at("/src/main.ts", 3, 23))) as { contents: { value: string } }
      expect(restored.contents.value).toContain("add(a: number, b: number): number")
      yield* server.sync("/src/new.ts", "export const fresh = 1\n")
      expect(yield* server.documentSymbols("/src/new.ts")).toMatchObject([{ name: "fresh", kind: 14 }])
      // Once closed, a file the commit lacks is gone, and the project still answers.
      yield* server.close("/src/new.ts")
      expect((yield* Effect.flip(server.documentSymbols("/src/new.ts"))).code).toBe("not_found")
      expect(yield* server.definition(at("/src/main.ts", 3, 23))).toHaveLength(1)
      expect(yield* server.documentSymbols("/src/empty.ts")).toEqual([])
      yield* server.refresh
    }).pipe(Effect.scoped))

  it.effect("a path outside the workspace is not found; a file that isn't text is refused; call hierarchy is unsupported", () =>
    Effect.gen(function*() {
      const { server } = yield* connect(PROJECT)
      const missing = yield* Effect.flip(server.hover(at("/src/nope.ts", 0, 0)))
      expect([missing.code, missing.method]).toEqual(["not_found", "hover"])
      const binary = yield* Effect.flip(server.diagnostics("/assets/logo.png"))
      expect(binary.code).toBe("binary_file")
      for (
        const request of [server.prepareCallHierarchy, server.callHierarchyIncoming, server.callHierarchyOutgoing]
      ) {
        expect((yield* Effect.flip(request(at("/src/main.ts", 0, 0)))).code).toBe("unsupported")
      }
    }).pipe(Effect.scoped))

  it.effect("a read that fails is a file that can't be read", () =>
    Effect.gen(function*() {
      const { server } = yield* connect(PROJECT, { read: () => Effect.fail("offline") })
      expect((yield* Effect.flip(server.hover(at("/src/main.ts", 0, 0)))).code).toBe("binary_file")
    }).pipe(Effect.scoped))

  it.effect("a lib file that fails to load is missing, and the server still answers", () =>
    Effect.gen(function*() {
      const { server } = yield* connect(PROJECT, {
        lib: (name) => (name === "lib.es2022.d.ts" ? Promise.reject(new Error("offline")) : lib(name))
      })
      const hover = (yield* server.hover(at("/src/main.ts", 3, 23))) as { contents: { value: string } }
      expect(hover.contents.value).toContain("add(a: number, b: number): number")
      // Without its lib, TypeScript reports the missing globals once, at no place in the file.
      const report = (yield* server.diagnostics("/src/lazy.ts")) as { items: Array<{ code: number; range: unknown }> }
      expect(report.items.find((item) => item.code === 2318)?.range).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
      })
    }).pipe(Effect.scoped))

  it.effect("the file limit stops a load: references then miss the files past it", () =>
    Effect.gen(function*() {
      const { reads, server } = yield* connect(PROJECT, { limits: { files: 4 } })
      const references = (yield* server.references(at("/src/main.ts", 3, 23))) as Array<{ uri: string }>
      expect(references.some((reference) => reference.uri === "file:///src/other.ts")).toBe(false)
      expect(reads.length).toBe(4)
    }).pipe(Effect.scoped))

  it.effect("the size limit stops a load once it is reached", () =>
    Effect.gen(function*() {
      const { reads, server } = yield* connect(PROJECT, { limits: { bytes: 1 } })
      const failure = yield* Effect.flip(server.hover(at("/src/main.ts", 3, 23)))
      expect(failure.code).toBe("response_too_large")
      expect(reads).toEqual(["tsconfig.json"])
    }).pipe(Effect.scoped))

  it.effect("a nested jsconfig.json is its own project; a file under no config gets the defaults", () =>
    Effect.gen(function*() {
      const { server } = yield* connect({
        "web/jsconfig.json":
          "{ \"extends\": \"./base.json\", \"compilerOptions\": { \"checkJs\": true, \"lib\": [\"es2022\"] } }",
        "web/base.json": "{}",
        "web/use.js": "import { greet } from \"./app.js\"\ngreet(\"you\")\n",
        "web/app.js": "export const greet = (name) => `hi ${name}`\nconst n = 1\nn.toFixed()\n",
        "loose.js": "export const loose = 1\n",
        "web/unreadable/tsconfig.json": undefined,
        "web/unreadable/index.ts": "export const x = 1\n"
      })
      const hover = (yield* server.hover(at("/web/app.js", 0, 14))) as { contents: { value: string } }
      expect(hover.contents.value).toContain("const greet: (name: any) => string")
      const references = (yield* server.references(at("/web/app.js", 0, 14))) as Array<{ uri: string }>
      expect(references.map((reference) => reference.uri).sort()).toEqual([
        "file:///web/app.js",
        "file:///web/use.js",
        "file:///web/use.js"
      ])
      expect(yield* server.documentSymbols("/loose.js")).toMatchObject([{ name: "loose" }])
      expect(yield* server.documentSymbols("/web/unreadable/index.ts")).toMatchObject([{ name: "x" }])
    }).pipe(Effect.scoped))

  it.effect("a compiler that throws is a failed request, and the next request is still answered", () =>
    Effect.gen(function*() {
      const faulty: TypeScriptWorkspace.TypeScript = {
        ...ts,
        createLanguageService: (host, registry) => ({
          ...ts.createLanguageService(host, registry),
          getQuickInfoAtPosition: () => {
            throw new Error("Debug Failure")
          }
        })
      }
      const { server } = yield* connect(PROJECT, { typescript: faulty })
      const failure = yield* Effect.flip(server.hover(at("/src/main.ts", 3, 23)))
      expect([failure.code, failure.message]).toEqual(["request_failed", "TypeScript failed"])
      expect(yield* server.definition(at("/src/main.ts", 3, 23))).toHaveLength(1)
    }).pipe(Effect.scoped))

  it.effect("a worker that fails fails what waits and everything after it, logged by its error's name", () => {
    const telemetry = Telemetry.make()
    return Effect.gen(function*() {
      const listeners: Array<(event: never) => void> = []
      const server = yield* BrowserLanguageServer.make({
        worker: () => ({
          postMessage: () => {},
          terminate: () => {},
          addEventListener: (type: "message" | "error", listener: (event: never) => void) => {
            if (type === "error") listeners.push(listener)
          }
        }),
        workspace: { paths: [], read: () => Effect.succeed(undefined) }
      })
      const waiting = yield* Effect.forkChild(Effect.flip(server.hover(at("/a.ts", 0, 0))))
      yield* Effect.yieldNow
      for (const listener of listeners) listener({ error: new TypeError("SENTINEL") } as never)
      expect((yield* Fiber.join(waiting)).code).toBe("provider_unavailable")
      expect((yield* Effect.flip(server.diagnostics("/a.ts"))).code).toBe("provider_unavailable")
      // A second failure changes nothing.
      for (const listener of listeners) listener(undefined as never)
      expect((yield* Effect.flip(server.diagnostics("/a.ts"))).message).toBe("The language server stopped")
      expect(telemetry.lines("browser.language_server.failed").map(({ annotations }) => annotations)).toEqual([
        expect.objectContaining({ "error.type": "TypeError" })
      ])
      expect(Telemetry.dump(telemetry)).not.toContain("SENTINEL")
    }).pipe(Effect.scoped, telemetry.observed)
  })

  it.effect("a worker error the browser gives no error for is logged as ErrorEvent", () => {
    const telemetry = Telemetry.make()
    return Effect.gen(function*() {
      const listeners: Array<(event: never) => void> = []
      const server = yield* BrowserLanguageServer.make({
        worker: () => ({
          postMessage: () => {},
          terminate: () => {},
          addEventListener: (type: "message" | "error", listener: (event: never) => void) => {
            if (type === "error") listeners.push(listener)
          }
        }),
        workspace: { paths: [], read: () => Effect.succeed(undefined) }
      })
      for (const listener of listeners) listener({ error: null } as never)
      expect((yield* Effect.flip(server.diagnostics("/a.ts"))).code).toBe("provider_unavailable")
      expect(telemetry.lines("browser.language_server.failed").map(({ annotations }) => annotations)).toEqual([
        expect.objectContaining({ "error.type": "ErrorEvent" })
      ])
    }).pipe(Effect.scoped, telemetry.observed)
  })

  it.effect("a request the worker doesn't answer in time times out, and its late answer is dropped", () =>
    Effect.gen(function*() {
      const posted: Array<{ _tag: string; id: number }> = []
      const deliver: Array<(event: { data: unknown }) => void> = []
      const server = yield* BrowserLanguageServer.make({
        worker: () => ({
          postMessage: (message) => posted.push(message as never),
          terminate: () => {},
          addEventListener: (type: "message" | "error", listener: (event: never) => void) => {
            if (type === "message") deliver.push(listener as never)
          }
        }),
        workspace: { paths: [], read: () => Effect.succeed(undefined) },
        timeout: "1 second"
      })
      const waiting = yield* Effect.forkChild(Effect.flip(server.hover(at("/a.ts", 0, 0))))
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      const failure = yield* Fiber.join(waiting)
      expect([failure.code, failure.method]).toEqual(["timeout", "hover"])
      const request = posted.find((message) => message._tag === "Request")!
      for (const listener of deliver) {
        listener({ data: { _tag: "Reply", id: request.id, result: null, files: 0, partial: false } })
      }
      yield* Effect.yieldNow
    }).pipe(Effect.scoped))

  it.effect("the worker refuses a request before its workspace opens and ignores files nobody asked for", () =>
    Effect.gen(function*() {
      const channel = new MessageChannel()
      channel.port2.start()
      yield* Effect.forkScoped(BrowserLanguageServer.program({ typescript: ts, lib, port: channel.port1 as never }))
      const answer = yield* Effect.callback<unknown>((resume) => {
        channel.port2.addEventListener("message", (event) => resume(Effect.succeed(event.data)), { once: true })
        channel.port2.postMessage({ _tag: "Files", id: 99, files: [] })
        channel.port2.postMessage({ _tag: "Request", id: 1, method: "hover", params: {} })
      })
      expect(answer).toEqual({
        _tag: "Refuse",
        id: 1,
        method: "hover",
        code: "invalid_input",
        message: "No workspace is open"
      })
      channel.port2.close()
    }).pipe(Effect.scoped))

  it.live("serve runs the program on the worker's own scope until the worker ends", () =>
    Effect.gen(function*() {
      const channel = new MessageChannel()
      channel.port2.start()
      const scope = globalThis as unknown as Record<string, unknown>
      const own = {
        postMessage: scope.postMessage,
        addEventListener: scope.addEventListener,
        removeEventListener: scope.removeEventListener,
        start: scope.start
      }
      Object.assign(scope, {
        postMessage: (message: unknown) => channel.port1.postMessage(message),
        addEventListener: channel.port1.addEventListener.bind(channel.port1),
        removeEventListener: channel.port1.removeEventListener.bind(channel.port1),
        start: channel.port1.start.bind(channel.port1)
      })
      const fiber = BrowserLanguageServer.serve({ typescript: ts, lib })
      const answer = yield* Effect.callback<unknown>((resume) => {
        channel.port2.addEventListener("message", (event) => resume(Effect.succeed(event.data)), { once: true })
        channel.port2.postMessage({ _tag: "Open", paths: [] })
        channel.port2.postMessage({ _tag: "Request", id: 0, method: "workspaceSymbols", params: { query: "x" } })
      })
      expect(answer).toEqual({ _tag: "Reply", id: 0, result: [], files: 0, partial: false })
      yield* Fiber.interrupt(fiber)
      Object.assign(scope, own)
      const other = new MessageChannel()
      const second = BrowserLanguageServer.serve({ typescript: ts, lib, port: other.port1 as never })
      yield* Fiber.interrupt(second)
      channel.port2.close()
    }))
})

describe("URIs and paths", () => {
  it("round-trips a path through its URI, encoding each segment", () => {
    const uri = BrowserLanguageServer.uriOf("/src/a b/#1.ts")
    expect(uri).toBe("file:///src/a%20b/%231.ts")
    expect(BrowserLanguageServer.pathOf(uri)).toBe("/src/a b/#1.ts")
    expect(BrowserLanguageServer.pathOf("https://example.com/a.ts")).toBeUndefined()
  })

  it("rejects malformed percent encoding without throwing", () => {
    for (const uri of ["file:///a%", "file:///a%ZZ.ts", "file:///%E0%A4.ts"]) {
      expect(BrowserLanguageServer.pathOf(uri)).toBeUndefined()
    }
  })

  it("tells TypeScript's lib files from the workspace's", () => {
    expect(BrowserLanguageServer.isLib("/.typescript/lib.es5.d.ts")).toBe(true)
    expect(BrowserLanguageServer.isLib("/src/lib.ts")).toBe(false)
  })
})

describe("TypeScriptWorkspace helpers", () => {
  it("counts lines the way the protocol does", () => {
    expect(TypeScriptWorkspace.lineStarts("a\nb\r\nc\rd")).toEqual([0, 2, 5, 7])
    const text = "ab\ncd"
    const starts = TypeScriptWorkspace.lineStarts(text)
    expect(TypeScriptWorkspace.offsetAt(text, starts, { line: 1, character: 1 })).toBe(4)
    expect(TypeScriptWorkspace.offsetAt(text, starts, { line: 0, character: 99 })).toBe(2)
    expect(TypeScriptWorkspace.offsetAt(text, starts, { line: 0, character: -1 })).toBe(0)
    expect(TypeScriptWorkspace.offsetAt(text, starts, { line: 9, character: 0 })).toBe(5)
    expect(TypeScriptWorkspace.positionAt(starts, 4)).toEqual({ line: 1, character: 1 })
    expect(TypeScriptWorkspace.positionAt(starts, 0)).toEqual({ line: 0, character: 0 })
    expect(TypeScriptWorkspace.positionAt(starts, 2)).toEqual({ line: 0, character: 2 })
  })

  it("resolves dot segments without leaving the root", () => {
    expect(TypeScriptWorkspace.normalize("/a/./b/../c")).toBe("/a/c")
    expect(TypeScriptWorkspace.normalize("/../x")).toBe("/x")
    expect(TypeScriptWorkspace.absolute("/x")).toBe("/x")
  })

  it("maps every element kind to the protocol's symbol kinds", () => {
    const kinds: Record<string, number> = {
      module: 2,
      "external module name": 2,
      class: 5,
      "local class": 5,
      method: 6,
      property: 7,
      getter: 7,
      setter: 7,
      accessor: 7,
      constructor: 9,
      enum: 10,
      interface: 11,
      type: 11,
      function: 12,
      "local function": 12,
      const: 14,
      "enum member": 22,
      "type parameter": 26,
      let: 13,
      var: 13
    }
    for (const [kind, expected] of Object.entries(kinds)) expect(TypeScriptWorkspace.symbolKind(kind)).toBe(expected)
  })

  it("maps every diagnostic category to a severity", () => {
    expect(TypeScriptWorkspace.severityOf(ts, ts.DiagnosticCategory.Error)).toBe(1)
    expect(TypeScriptWorkspace.severityOf(ts, ts.DiagnosticCategory.Warning)).toBe(2)
    expect(TypeScriptWorkspace.severityOf(ts, ts.DiagnosticCategory.Message)).toBe(3)
    expect(TypeScriptWorkspace.severityOf(ts, ts.DiagnosticCategory.Suggestion)).toBe(4)
  })
})

describe("TypeScriptWorkspace cancellation recovery", () => {
  it.live("retries the import closure of a partially loaded root", () =>
    Effect.gen(function*() {
      const reading = yield* Deferred.make<void>()
      let stalled = true
      const project: Record<string, string> = {
        "/root.ts": "import { value } from \"./dep\"\nexport const x = value\n",
        "/dep.ts": "export const value = 1\n"
      }
      const workspace = TypeScriptWorkspace.make(ts, Object.keys(project), {
        lib: (name) => Effect.promise(() => lib(name)),
        read: (paths) =>
          stalled && paths.includes("/dep.ts")
            ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(paths.map((path) => [path, project[path] ?? null] as const))
      })
      const interrupted = yield* Effect.forkChild(workspace.definition("/root.ts", { line: 1, character: 18 }))
      yield* Deferred.await(reading).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(interrupted)
      stalled = false
      expect(yield* workspace.definition("/root.ts", { line: 1, character: 18 })).toMatchObject([
        { uri: "file:///dep.ts" }
      ])
    }))

  it.live("retries the library closure after a lib read is interrupted", () =>
    Effect.gen(function*() {
      const reading = yield* Deferred.make<void>()
      let stalled = true
      const workspace = TypeScriptWorkspace.make(ts, ["/a.ts"], {
        lib: (name) =>
          stalled && name === "lib.esnext.d.ts"
            ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.promise(() => lib(name)),
        read: (paths) => Effect.succeed(paths.map((path) => [path, "const xs: Array<number> = [1]\n"] as const))
      })
      const interrupted = yield* Effect.forkChild(workspace.diagnostics("/a.ts"))
      yield* Deferred.await(reading).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(interrupted)
      stalled = false
      expect(yield* workspace.diagnostics("/a.ts")).toMatchObject({ items: [] })
    }))

  it.live("retries project widening after its workspace read is interrupted", () =>
    Effect.gen(function*() {
      const reading = yield* Deferred.make<void>()
      let stalled = true
      const project: Record<string, string> = {
        "/a.ts": "export const value = 1\n",
        "/b.ts": "import { value } from \"./a\"\nexport const x = value\n"
      }
      const workspace = TypeScriptWorkspace.make(ts, Object.keys(project), {
        lib: (name) => Effect.promise(() => lib(name)),
        read: (paths) =>
          stalled && paths.includes("/b.ts")
            ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(paths.map((path) => [path, project[path] ?? null] as const))
      })
      const interrupted = yield* Effect.forkChild(workspace.references("/a.ts", { line: 0, character: 14 }))
      yield* Deferred.await(reading).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(interrupted)
      stalled = false
      const references = yield* workspace.references("/a.ts", { line: 0, character: 14 })
      expect(references).toMatchObject([
        { uri: "file:///a.ts" },
        { uri: "file:///b.ts" },
        { uri: "file:///b.ts" }
      ])
    }))
})
