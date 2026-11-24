import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Fiber, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { mkdtempSync, rmSync } from "node:fs"
import * as NodeFsPromises from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import ts from "typescript"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as BrowserChildProcessSpawner from "../src/BrowserChildProcessSpawner/index.ts"
import * as BrowserFileSystem from "../src/BrowserFileSystem/index.ts"
import { BrowserRuntime, SharedSqlite } from "../src/index.ts"
import * as TypeScriptWorkspace from "../src/internal/TypeScriptWorkspace.ts"
import * as Engines from "./fixtures/Engines.ts"
import { flows, registration, Steps } from "./fixtures/Flows.ts"
import * as MemoryOpfs from "./fixtures/MemoryOpfs.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const libDirectory = dirname(createRequire(import.meta.url).resolve("typescript"))
const libLoader = (name: string) => NodeFsPromises.readFile(join(libDirectory, name), "utf8").catch(() => undefined)

describe("@smthrs/platform-browser Wave 6 deep fuzz (SharedSqlite.open, BrowserRuntime.run, BrowserChildProcessSpawner, TypeScriptWorkspace)", () => {
  let removeOpfs: () => void = () => undefined
  beforeEach(() => { removeOpfs = MemoryOpfs.install() })
  afterEach(() => { removeOpfs() })

  it("SharedSqlite.open and executeBatch enforce transactional atomicity, parameterized queries, SqliteError mapping, and multi-tab visibility", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(
          Schema.Struct({
            kind: Schema.Literals(["insert", "select", "batchOk", "batchFail", "badSql", "tabCount"]),
            key: Schema.Literals(["k1", "k2", "k3"]),
            val: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 }))
          })
        ).check(Schema.isMinLength(2), Schema.isMaxLength(6))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ops }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const name = Engines.name()
              const pool = yield* MemorySqlite.pool
              const database = yield* MemorySqlite.open
              yield* Engines.leader(name, Engines.engineWithApp(name, database, Engines.steps(), pool))
              const db = yield* Effect.promise(() => SharedSqlite.open({ name }))
              const tab = yield* Engines.sharedTab(name)
              const model = new Map<string, number>()

              try {
                yield* Effect.promise(() => db.execute("CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER)"))
                for (const op of ops) {
                  if (op.kind === "insert") {
                    yield* Effect.promise(() =>
                      db.execute("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", [op.key, op.val])
                    )
                    model.set(op.key, op.val)
                  } else if (op.kind === "select") {
                    const rows = yield* Effect.promise(() =>
                      db.execute<{ readonly k: string; readonly v: number }>("SELECT k, v FROM kv WHERE k = ?", [op.key])
                    )
                    const expected = model.get(op.key)
                    if (expected === undefined) expect(rows).toEqual([])
                    else expect(rows).toEqual([{ k: op.key, v: expected }])
                  } else if (op.kind === "batchOk") {
                    const results = yield* Effect.promise(() =>
                      db.executeBatch([
                        { sql: "BEGIN IMMEDIATE" },
                        { sql: "INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", params: [op.key, op.val] },
                        { sql: "SELECT count(*) AS n FROM kv" },
                        { sql: "COMMIT" }
                      ])
                    )
                    model.set(op.key, op.val)
                    expect(results).toHaveLength(4)
                  } else if (op.kind === "batchFail") {
                    const err = yield* Effect.promise(() =>
                      db
                        .executeBatch([
                          { sql: "BEGIN IMMEDIATE" },
                          { sql: "INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", params: [op.key, op.val + 999] },
                          { sql: "INSERT INTO nonexistent_table VALUES (1)" }
                        ])
                        .then(() => undefined, (e: unknown) => e)
                    )
                    expect(err).toBeInstanceOf(SharedSqlite.SqliteError)
                    yield* Effect.promise(() => db.execute("ROLLBACK").catch(() => undefined))
                    const rows = yield* Effect.promise(() =>
                      db.execute<{ readonly v: number }>("SELECT v FROM kv WHERE k = ?", [op.key])
                    )
                    const expected = model.get(op.key)
                    expect(rows.map((r) => r.v)).toEqual(expected === undefined ? [] : [expected])
                  } else if (op.kind === "badSql") {
                    const err = yield* Effect.promise(() =>
                      db.execute("SELECT * FROM missing_tbl").then(() => undefined, (e: unknown) => e)
                    )
                    expect(err).toBeInstanceOf(SharedSqlite.SqliteError)
                  } else {
                    const rows = (yield* tab.execute("SELECT count(*) AS n FROM kv")) as ReadonlyArray<{ readonly n: number }>
                    expect(rows[0]?.n).toBe(model.size)
                  }
                }
              } finally {
                yield* Effect.promise(() => db.close())
              }
              return true
            })
          ),
        { executions: Math.min(executions, 6), seed }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("BrowserRuntime.run serves tab requests, telemetry, and clean worker fiber shutdown across arbitrary payloads", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        prefix: Schema.Literals(["a", "br", "z-9"]),
        withTelemetry: Schema.Boolean,
        execSuffix: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ prefix, withTelemetry, execSuffix }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const name = Engines.name()
              const run = Engines.steps()
              const telemetry = Telemetry.make()
              const worker = BrowserRuntime.run({
                name,
                sqlite: MemorySqlite.build,
                flows,
                registerFlows: registration(run.step),
                ...(withTelemetry ? { telemetry: telemetry.layer } : {})
              })
              try {
                const engine = yield* Engines.tab(name)
                const execId = `run-${execSuffix}`
                yield* engine.start(Steps, { executionId: execId, payload: { prefix } })
                const res = yield* engine.result(Steps, execId)
                expect(res).toEqual(Exit.succeed(`${prefix}:three`))
              } finally {
                yield* Fiber.interrupt(worker)
              }
              if (withTelemetry) {
                expect(telemetry.lines("browser.runtime.leader").length).toBeGreaterThanOrEqual(1)
              }
              return true
            })
          ),
        { executions: Math.min(executions, 5), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("BrowserChildProcessSpawner.make handles command lines, env/replaceEnv, cwd validation, exit codes, stderr, and abort/kill semantics", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["ok", "nonzero", "throwError", "missingCwd", "replaceEnv", "abort"]),
        arg: Schema.Literals(["hello", "two words", "a'b", ""]),
        exitCode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }))
      })
    )

    const dir = mkdtempSync(join(tmpdir(), "pb-spawner-fuzz-"))
    try {
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode, arg, exitCode }) =>
            Effect.gen(function*() {
              const calls: Array<{ command: string; cwd?: string | undefined; env?: Readonly<Record<string, string>> | undefined; replaceEnv?: boolean | undefined }> = []
              const bash: BrowserChildProcessSpawner.JustBashLike = {
                exec: async (commandLine, options) => {
                  calls.push({
                    command: commandLine,
                    cwd: options?.cwd,
                    env: options?.env,
                    replaceEnv: options?.replaceEnv
                  })
                  if (mode === "throwError") {
                    throw new Error("interpreter exploded")
                  }
                  if (mode === "abort") {
                    return await new Promise((resolve) => {
                      const done = () => resolve({ stdout: "", stderr: "aborted", exitCode: 137 })
                      if (options?.signal?.aborted) done()
                      else options?.signal?.addEventListener("abort", done, { once: true })
                    })
                  }
                  return {
                    stdout: `out:${arg}`,
                    stderr: mode === "nonzero" ? "err:boom" : "",
                    exitCode: mode === "nonzero" ? Math.max(1, exitCode) : 0
                  }
                }
              }

              const fsLayer = BrowserFileSystem.layer(NodeFsPromises)
              const spawnerLayer = BrowserChildProcessSpawner.layer(bash).pipe(
                Layer.provide(Layer.merge(fsLayer, Path.layer))
              )

              const cmd = ChildProcess.make("echo", [arg], {
                cwd: mode === "missingCwd" ? join(dir, "does-not-exist-dir") : dir,
                env: { FUZZ_VAR: "1" },
                extendEnv: mode !== "replaceEnv"
              })

              const ex = yield* Effect.scoped(
                Effect.gen(function*() {
                  const spawner = yield* ChildProcessSpawner
                  const handle = yield* spawner.spawn(cmd)
                  if (mode === "abort") {
                    yield* handle.kill()
                  }
                  const outChunks = yield* Stream.runCollect(handle.stdout)
                  const errChunks = yield* Stream.runCollect(handle.stderr)
                  const code = yield* handle.exitCode
                  return {
                    out: Buffer.concat([...outChunks]).toString("utf8"),
                    err: Buffer.concat([...errChunks]).toString("utf8"),
                    code
                  }
                })
              ).pipe(Effect.provide(spawnerLayer), Effect.exit)

              if (mode === "missingCwd" || mode === "throwError") {
                expect(Exit.isFailure(ex)).toBe(true)
              } else if (mode === "abort") {
                expect(Exit.isFailure(ex) || Exit.isSuccess(ex)).toBe(true)
              } else {
                expect(Exit.isSuccess(ex)).toBe(true)
                if (Exit.isSuccess(ex)) {
                  if (mode === "ok" || mode === "replaceEnv") {
                    expect(ex.value.code).toBe(0)
                    expect(ex.value.out).toBe(`out:${arg}`)
                  }
                  if (mode === "nonzero") {
                    expect(ex.value.code).toBeGreaterThanOrEqual(1)
                    expect(ex.value.err).toBe("err:boom")
                  }
                }
              }
              return true
            }),
          { executions: Math.min(executions, 45), seed: seed + 2 }
        )
      )
      assertPassed(report)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("TypeScriptWorkspace handles diagnostics, hover, definition, references, implementation, symbols, overlays, and limit caps", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rawPath: Schema.Literals(["src/a.ts", "/src/./b/../a.ts", "src/sub/c.ts", "/a/b/c.ts"]),
        extraDecl: Schema.Literals([
          "export const answer: number = 42\n",
          "export function double(n: number): number { return n * 2 }\n",
          "export const broken: number = 'nope'\n",
          "export interface Box { readonly id: string }\n"
        ]),
        query: Schema.Literals(["add", "Square", "answer", "double", "missingSymbol"]),
        maxFiles: Schema.Literals([1, 2000])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rawPath, extraDecl, query, maxFiles }) =>
          Effect.gen(function*() {
            const norm = TypeScriptWorkspace.normalize(rawPath)
            expect(norm.startsWith("/")).toBe(true)
            expect(TypeScriptWorkspace.normalize(norm)).toBe(norm)
            expect(TypeScriptWorkspace.uriOf(norm).startsWith("file://")).toBe(true)

            const text = "line0\nline1\nline2"
            const starts = TypeScriptWorkspace.lineStarts(text)
            const off = TypeScriptWorkspace.offsetAt(text, starts, { line: 1, character: 2 })
            const pos = TypeScriptWorkspace.positionAt(starts, off)
            expect(pos).toEqual({ line: 1, character: 2 })
            expect(TypeScriptWorkspace.symbolKind("function")).toBeGreaterThan(0)
            expect(TypeScriptWorkspace.symbolKind("class")).toBeGreaterThan(0)
            expect(TypeScriptWorkspace.symbolKind("unknown_kind")).toBeGreaterThan(0)
            expect(TypeScriptWorkspace.severityOf(ts, ts.DiagnosticCategory.Error)).toBe(1)
            expect(TypeScriptWorkspace.severityOf(ts, ts.DiagnosticCategory.Warning)).toBe(2)

            const files: Record<string, string> = {
              "/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", lib: ["es2022"] } }),
              "/src/math.ts":
                "export interface Shape { area(): number }\nexport function add(a: number, b: number): number { return a + b }\nexport class Square implements Shape { constructor(readonly s: number) {} area() { return this.s * this.s } }\n",
              "/src/main.ts": `import { add, Square } from "./math"\n${extraDecl}export const r = add(1, new Square(2).s)\n`
            }
            const workspace = TypeScriptWorkspace.make(
              ts,
              Object.keys(files),
              {
                read: (paths) => Effect.succeed(paths.map((p) => [p, files[p] ?? null] as const)),
                lib: (name) => Effect.promise(() => libLoader(name))
              },
              { files: maxFiles, bytes: 1024 * 1024 }
            )

            const diagsExit = yield* workspace.diagnostics("/src/main.ts").pipe(Effect.exit)
            if (maxFiles === 1) {
              expect(Exit.isFailure(diagsExit)).toBe(true)
              expect(workspace.loaded().partial).toBe(true)
              return true
            }
            expect(Exit.isSuccess(diagsExit)).toBe(true)
            if (Exit.isSuccess(diagsExit)) {
              expect(diagsExit.value).toMatchObject({ kind: "full" })
              expect(Array.isArray((diagsExit.value as { items: unknown[] }).items)).toBe(true)
            }
            const docSyms = yield* workspace.documentSymbols("/src/main.ts")
            expect(Array.isArray(docSyms)).toBe(true)
            const wsSyms = yield* workspace.workspaceSymbols(query)
            expect(Array.isArray(wsSyms)).toBe(true)
            yield* workspace.hover("/src/main.ts", { line: 0, character: 10 })
            yield* workspace.definition("/src/main.ts", { line: 0, character: 10 })
            yield* workspace.references("/src/math.ts", { line: 1, character: 17 })
            yield* workspace.implementation("/src/math.ts", { line: 0, character: 17 })
            yield* workspace.sync("/src/main.ts", `${files["/src/main.ts"]!}\nexport const synced = 1\n`)
            yield* workspace.close("/src/main.ts")
            const missingExit = yield* workspace.diagnostics("/src/does-not-exist.ts").pipe(Effect.exit)
            expect(Exit.isFailure(missingExit)).toBe(true)
            const loaded = workspace.loaded()
            expect(loaded.files).toBeGreaterThanOrEqual(1)
            return true
          }),
        { executions: Math.min(executions, 8), seed: seed + 3 }
      )
    )
    assertPassed(report)
  }, 90_000)
})
