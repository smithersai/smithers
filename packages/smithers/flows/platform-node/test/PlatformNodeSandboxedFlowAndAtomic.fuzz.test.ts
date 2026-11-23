import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { checkFileSystemBatch } from "@smthrs/kernel/test/contract"
import * as Workspace from "@smthrs/kernel/Workspace"
import { DirectorySandbox, RemoteChildProcessSpawner, Sandbox } from "@smthrs/sandbox"
import { Arbitrary, Effect, Exit, FileSystem, Layer, Logger, Schema, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"
import * as AtomicProtocol from "../src/internal/AtomicFileSystemProtocol.ts"
import * as NodeHost from "../src/NodeHost.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import * as SandboxedFlow from "../src/SandboxedFlow.ts"
import * as ScopedProcess from "../src/ScopedProcess.ts"
import { changed, patchedPaths, repository } from "./fixtures/repository.ts"
import * as childEntry from "./fixtures/sandboxed-child.ts"

const { Failing, Sum, Writer } = childEntry
const { ProviderError } = RemoteChildProcessSpawner

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const ioExecutions = Math.max(6, Math.min(baseExecutions, 12))
const fastExecutions = Math.max(16, Math.min(baseExecutions, 40))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-pn-sfa-fuzz-")))
const entryUrl = new URL("./fixtures/sandboxed-child.ts", import.meta.url)
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let seq = 0
const freshDir = (prefix: string) => {
  const dir = join(root, `${prefix}-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const containedHost = NodeHost.layerContained({ graceMs: 80 }).pipe(
  Layer.provide(ProcessLedger.layerMemory({ hostId: "sfa-fuzz", ownerPid: process.pid }))
)

describe("@smthrs/platform-node SandboxedFlow, AtomicFileSystem batch/protocol, ProcessReaper & ProcessSupervisor/PipedProcess fuzz", () => {
  it("SandboxedFlow.execute runs real bundled guest flows, captures work, propagates typed errors & handles transport/runtime faults", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        caseKind: Schema.Literals([
          "sum",
          "writer-capture",
          "typed-fail",
          "fault-spawn",
          "fault-write",
          "bad-runtime-exit",
          "bad-runtime-json",
          "missing-entry"
        ]),
        n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
      })
    )

    const baseProvider = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner
        return DirectorySandbox.make({ fs, spawner, root: freshDir("sb-root") })
      }).pipe(Effect.provide(containedHost))
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.gen(function*() {
            const session = `sfa-${++seq}`
            if (tc.caseKind === "sum") {
              const res = yield* SandboxedFlow.execute(Sum, { n: tc.n }, {
                provider: baseProvider,
                session,
                entry: entryUrl
              })
              expect(res.output).toBe(tc.n + 11)
              expect(res.work).toBeNull()
              return true
            }
            if (tc.caseKind === "writer-capture") {
              const repoProvider = repository(baseProvider)
              const res = yield* SandboxedFlow.execute(
                Writer,
                { count: 2, bytes: 8, directory: "out" },
                {
                  provider: repoProvider,
                  session,
                  entry: realpathSync(new URL(entryUrl)),
                  captureWork: true
                }
              )
              expect(res.output).toBe(2)
              const w = changed(res.work)
              expect(patchedPaths(w.patch)).toEqual(["out/file-0.bin", "out/file-1.bin"])
              return true
            }
            if (tc.caseKind === "typed-fail") {
              const exit = yield* SandboxedFlow.execute(Failing, { reason: `err-${tc.n}`, chatter: 0 }, {
                provider: baseProvider,
                session,
                entry: entryUrl
              }).pipe(Effect.exit)
              expect(Exit.isFailure(exit)).toBe(true)
              return true
            }
            if (tc.caseKind === "fault-spawn" || tc.caseKind === "fault-write") {
              const faultyProvider: Sandbox.Provider = {
                acquire: (key) =>
                  Effect.map(baseProvider.acquire(key), (s): Sandbox.Session => ({
                    ...s,
                    spawn: (cmd, opts) =>
                      tc.caseKind === "fault-spawn"
                        ? Effect.fail(new ProviderError({ code: "spawn_error", message: "spawn refused" }))
                        : s.spawn(cmd, opts),
                    writeFile: (p, c) =>
                      tc.caseKind === "fault-write"
                        ? Effect.fail(new ProviderError({ code: "unknown", message: "write refused" }))
                        : s.writeFile(p, c)
                  }))
              }
              const exit = yield* SandboxedFlow.execute(Sum, { n: 1 }, {
                provider: faultyProvider,
                session,
                entry: entryUrl
              }).pipe(Effect.exit)
              expect(Exit.isFailure(exit)).toBe(true)
              return true
            }
            if (tc.caseKind === "bad-runtime-exit" || tc.caseKind === "bad-runtime-json") {
              const rtDir = freshDir("rt")
              const rtPath = join(rtDir, "guest.sh")
              writeFileSync(
                rtPath,
                tc.caseKind === "bad-runtime-exit"
                  ? "#!/bin/sh\necho broken >&2\nexit 17\n"
                  : "#!/bin/sh\necho not-json-envelope\nexit 0\n",
                { mode: 0o755 }
              )
              const exit = yield* SandboxedFlow.execute(Sum, { n: 1 }, {
                provider: baseProvider,
                session,
                entry: entryUrl,
                runtime: rtPath
              }).pipe(Effect.exit)
              expect(Exit.isFailure(exit)).toBe(true)
              return true
            }
            // missing-entry
            const exit = yield* SandboxedFlow.execute(Sum, { n: 1 }, {
              provider: baseProvider,
              session,
              entry: join(root, "does-not-exist-entry.ts")
            }).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions: Math.max(8, Math.min(ioExecutions, 10)) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  }, 60_000)

  it("AtomicFileSystem batch contract, guarded mutations & AtomicFileSystemProtocol fuzz", async () => {
    // 1. Run shared kernel batch contract against real confined AtomicFileSystem helper
    const contractDir = freshDir("atomic-contract")
    writeFileSync(join(contractDir, "source.txt"), "host-contract")
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* checkFileSystemBatch(yield* FileSystem.FileSystem, contractDir)
      }).pipe(Effect.provide(Layer.mergeAll(AtomicFileSystem.layer, NodePath.layer, silentLogger)))
    )

    // 2. Fuzz guarded batch execute & direct FS operations (write, read, stat, copy, rename, remove, symlink, open, escape refusal)
    const arb = Arbitrary.schema(
      Schema.Struct({
        name: Schema.Literals(["a.txt", "sub/b.txt", "nested/deep/c.bin"]),
        body: Schema.Literals(["hello", "line1\nline2", "0123456789abcdef"]),
        op: Schema.Literals(["batch-read", "write-read-rename", "copy-remove", "escape-refusal", "protocol-decode"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.gen(function*() {
            const wsDir = freshDir("atomic-ws")
            const guarded = KernelFileSystem.layer.pipe(
              Layer.provide(AtomicFileSystem.layer),
              Layer.provide(NodePath.layer),
              Layer.provide(Workspace.layer(wsDir)),
              Layer.provide(GrantStore.layerNoop)
            )
            const fullPath = join(wsDir, tc.name)
            mkdirSync(join(fullPath, ".."), { recursive: true })
            writeFileSync(fullPath, tc.body)

            if (tc.op === "batch-read") {
              const res = yield* Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                const b = KernelFileSystem.batch(fs)!
                return yield* b.execute([
                  { operation: "readDirectory", path: wsDir },
                  { operation: "stat", path: fullPath },
                  { operation: "digest", path: fullPath },
                  { operation: "stat", path: join(wsDir, "missing.txt") }
                ])
              }).pipe(Effect.provide(guarded))
              expect(res.entries.length).toBe(4)
              return true
            }

            if (tc.op === "write-read-rename") {
              yield* Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                const target = join(wsDir, "written.txt")
                const moved = join(wsDir, "moved.txt")
                yield* fs.writeFileString(target, tc.body)
                expect(yield* fs.readFileString(target)).toBe(tc.body)
                yield* fs.chmod(target, 0o640)
                yield* fs.truncate(target, Math.min(4, tc.body.length))
                yield* fs.rename(target, moved)
                expect(yield* fs.exists(moved)).toBe(true)
              }).pipe(Effect.provide(Layer.mergeAll(AtomicFileSystem.layer, NodePath.layer)))
              return true
            }

            if (tc.op === "copy-remove") {
              yield* Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                const dst = join(wsDir, "copied.txt")
                yield* fs.copyFile(fullPath, dst)
                expect(yield* fs.readFileString(dst)).toBe(tc.body)
                yield* fs.remove(dst)
                expect(yield* fs.exists(dst)).toBe(false)
              }).pipe(Effect.provide(Layer.mergeAll(AtomicFileSystem.layer, NodePath.layer)))
              return true
            }

            if (tc.op === "escape-refusal") {
              const exit = yield* Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                return yield* fs.readFileString("/etc/passwd")
              }).pipe(Effect.provide(guarded), Effect.exit)
              expect(Exit.isFailure(exit)).toBe(true)
              return true
            }

            // AtomicProtocol encode & decode edge cases
            const limits = { request: 4096, content: 4096, response: 4096, stderr: 4096, batchSize: 128, batchEntry: 4096 }
            const bodyBuf = Buffer.from(JSON.stringify({ ok: true, value: tc.body }), "utf8")
            const encoded = AtomicProtocol.encode(bodyBuf, limits)
            expect(encoded.byteLength).toBeGreaterThan(bodyBuf.byteLength)
            for (
              const badFrame of [
                Buffer.from(""),
                Buffer.from("no-newline"),
                Buffer.from("wrong-tag 2\n{}"),
                Buffer.from("smithers-atomic-fs/1 abc\n{}"),
                Buffer.from("smithers-atomic-fs/1 999999\n{}"),
                Buffer.from("smithers-atomic-fs/1 5\n{bad"),
                Buffer.from("smithers-atomic-fs/1 4\n{bad")
              ]
            ) {
              expect(() => AtomicProtocol.decode(badFrame, limits)).toThrow()
            }
            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed: seed + 1, executions: ioExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("ProcessReaper, ProcessSupervisor, PipedProcess & ScopedProcess fuzz real process pipelines, stdin/stdout, exit codes & descendant reaping", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["echo", "pipe2", "pipe3", "stdin-cat", "nonzero", "reap-bg", "scoped-proc"]),
        payload: Schema.Literals(["alpha", "line1\nline2\nline3", "x".repeat(256)])
      })
    )

    const reaperLayer = ProcessReaper.layerSpawner({ graceMs: 60 }).pipe(
      Layer.provide(ProcessLedger.layerMemory({ hostId: "reaper-fuzz", ownerPid: process.pid }))
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.scoped(
            Effect.gen(function*() {
              const spawner = yield* ChildProcessSpawner
              if (tc.mode === "echo") {
                const out = yield* spawner.string(ChildProcess.make("printf", ["%s", tc.payload]))
                expect(out).toBe(tc.payload)
                return true
              }
              if (tc.mode === "pipe2") {
                const piped = ChildProcess.make("printf", ["%s", tc.payload]).pipe(
                  ChildProcess.pipeTo(ChildProcess.make("tr", ["a-z", "A-Z"]))
                )
                const out = yield* spawner.string(piped)
                expect(out).toBe(tc.payload.toUpperCase())
                return true
              }
              if (tc.mode === "pipe3") {
                const piped = ChildProcess.make("printf", ["%s\n", tc.payload]).pipe(
                  ChildProcess.pipeTo(ChildProcess.make("cat", [])),
                  ChildProcess.pipeTo(ChildProcess.make("wc", ["-c"]))
                )
                const out = yield* spawner.string(piped)
                expect(Number(out.trim())).toBeGreaterThan(0)
                return true
              }
              if (tc.mode === "stdin-cat") {
                const handle = yield* spawner.spawn(
                  ChildProcess.make("cat", [], {
                    stdin: Stream.make(new TextEncoder().encode(tc.payload))
                  })
                )
                const [out, code] = yield* Effect.all([
                  Stream.mkString(Stream.decodeText(handle.stdout)),
                  handle.exitCode
                ], { concurrency: "unbounded" })
                expect(out).toBe(tc.payload)
                expect(code).toBe(0)
                return true
              }
              if (tc.mode === "nonzero") {
                const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", "echo fail >&2; exit 9"]))
                const [err, code] = yield* Effect.all([
                  Stream.mkString(Stream.decodeText(handle.stderr)),
                  handle.exitCode
                ], { concurrency: "unbounded" })
                expect(err).toContain("fail")
                expect(code).toBe(9)
                return true
              }
              if (tc.mode === "reap-bg") {
                // Spawn a shell that forks a sleeping child; closing inner scope must reap the whole process group!
                yield* Effect.scoped(
                  Effect.gen(function*() {
                    const handle = yield* spawner.spawn(
                      ChildProcess.make("sh", ["-c", "sleep 20 & echo started; wait"])
                    )
                    const firstChunk = yield* handle.stdout.pipe(
                      Stream.decodeText,
                      Stream.take(1),
                      Stream.runCollect
                    )
                    expect(firstChunk.length).toBeGreaterThanOrEqual(1)
                  })
                )
                return true
              }
              // ScopedProcess direct execution
              const handle = yield* ScopedProcess.spawn({ command: "echo", args: ["scoped-ok"] })
              const out = yield* Stream.mkString(Stream.decodeText(handle.stdout))
              expect(out.trim()).toBe("scoped-ok")
              expect(yield* handle.exitCode).toBe(0)
              return true
            }).pipe(Effect.provide(reaperLayer))
          ).pipe(Effect.provide(silentLogger)),
        { seed: seed + 2, executions: Math.max(10, Math.min(fastExecutions, 20)) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })
})
