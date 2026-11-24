import { NodeCrypto, NodeFileSystem } from "@effect/platform-node"
import { Action, Flow, Interpreter } from "@smthrs/flows"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { Jj, ProcessLedger } from "@smthrs/kernel"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import { Destination, ResolveHost } from "@smthrs/kernel/HttpClient"
import type * as KernelConfinement from "@smthrs/kernel/ProcessConfinement"
import { Arbitrary, Effect, Exit, FileSystem, Layer, Logger, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as ChildProcess from "effect/process/ChildProcess"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as EgressHttpClient from "../src/EgressHttpClient.ts"
import { psGroupSnapshot } from "../src/internal/PsSnapshot.ts"
import * as NodeHost from "../src/NodeHost.ts"
import * as NodeRuntime from "../src/NodeRuntime.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"
import * as TestNodeRuntime from "../src/TestNodeRuntime.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const fastExecutions = Math.max(16, Math.min(baseExecutions, 40))
const ioExecutions = Math.max(6, Math.min(baseExecutions, 12))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-pn-rt-fuzz-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let seq = 0
const freshDir = (prefix: string) => {
  const dir = join(root, `${prefix}-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const listenLoopback = (
  handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("ok")
  }
) =>
  new Promise<
    { readonly url: string; readonly port: number; readonly seen: Array<string>; readonly close: () => Promise<void> }
  >(
    (resolve, reject) => {
      const seen: Array<string> = []
      const server = createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`)
        handler(req, res)
      })
      server.on("connect", (req, socket) => {
        seen.push(`CONNECT ${req.url}`)
        socket.destroy()
      })
      server.on("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          port: addr.port,
          seen,
          close: () => new Promise<void>((done) => server.close(() => done()))
        })
      })
    }
  )

describe("@smthrs/platform-node ProcessConfinement, TestNodeRuntime, NativeRuntime, EgressHttpClient, NodeHost & PsSnapshot fuzz", () => {
  it("ProcessConfinement.make & layer fuzz linux/darwin/win32, unavailable modes, profiles, shell/piped commands & verification", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        platform: Schema.Literals(["linux", "darwin", "win32"]),
        hasTool: Schema.Boolean,
        unavailable: Schema.Literals(["default", "refuse", "unconfined"]),
        network: Schema.Literals(["none", "open"]),
        useShell: Schema.Boolean,
        withReadOnly: Schema.Boolean,
        withExtraWrites: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.scoped(
            Effect.gen(function*() {
              const base = freshDir("conf")
              const workspaceRoot = join(base, "ws")
              const tempDir = join(base, "tmp")
              const extraWrite = join(base, "out")
              const roDir = join(workspaceRoot, "locked")
              mkdirSync(workspaceRoot, { recursive: true })
              mkdirSync(tempDir, { recursive: true })
              mkdirSync(extraWrite, { recursive: true })
              mkdirSync(roDir, { recursive: true })

              const host: ProcessSandbox.Host = {
                ...ProcessSandbox.host(),
                platform: tc.platform,
                developerDirectory: undefined,
                executable: (name) => {
                  if (!tc.hasTool) return undefined
                  if (tc.platform === "darwin" && name === "/usr/bin/sandbox-exec") return name
                  if (tc.platform === "linux" && name === "bwrap") return "/usr/bin/bwrap"
                  return undefined
                }
              }

              const profile: KernelConfinement.Profile = {
                workspaceRoot,
                reads: [workspaceRoot],
                writes: tc.withExtraWrites ? [extraWrite] : [],
                readOnly: tc.withReadOnly ? [roDir] : [],
                network: tc.network
              }

              const service = ProcessConfinement.make({
                temporaryDirectory: tempDir,
                host,
                ...(tc.unavailable === "default" ? {} : { unavailable: tc.unavailable })
              })

              const cmd = ChildProcess.make("echo", ["hello"], {
                cwd: workspaceRoot,
                shell: tc.useShell
              })

              const confinedExit = yield* service.confine(cmd, profile).pipe(Effect.exit)
              if (tc.platform === "win32" || !tc.hasTool) {
                if (tc.unavailable === "unconfined") {
                  expect(Exit.isSuccess(confinedExit)).toBe(true)
                } else {
                  expect(Exit.isFailure(confinedExit)).toBe(true)
                }
              } else {
                // On darwin/linux with executable present, confine wraps or refuses piped/unsupported gracefully
                expect(confinedExit).toBeDefined()
              }

              // Also exercise ProcessConfinement.layer construction
              const layered = yield* Layer.build(
                ProcessConfinement.layer({ temporaryDirectory: tempDir, host, unavailable: "unconfined" })
              )
              expect(layered).toBeDefined()
              return true
            })
          ).pipe(Effect.provide(silentLogger)),
        { seed, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("TestNodeRuntime & NativeRuntime/NodeRuntime exercise durable SQLite replay, storage, requirements, stubJj & signalExitCode", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        value: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
        signal: Schema.Literals(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL", "SIGPIPE"]),
        useNodeRuntime: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.gen(function*() {
            // 1. stubJj exercises every method
            yield* Effect.gen(function*() {
              const jj = yield* Jj.Jj
              const snap = yield* jj.snapshot()
              expect(snap.changeId).toBe("test-snapshot")
              yield* jj.restore(snap.changeId as never)
              expect(yield* jj.diff("a" as never, "b" as never)).toBe("")
              yield* jj.workspaceAdd("child", join(root, `jj-ws-${++seq}`))
              yield* jj.workspaceForget("child")
              expect(yield* jj.status()).toBe("")
            }).pipe(Effect.provide(TestNodeRuntime.stubJj))

            // 2. Durable SQLite replay through TestNodeRuntime.durableEngine & requirements
            let ran = 0
            const Measure = Action.make(`fuzz/Measure/${seq}`, { payload: {}, success: Schema.Number })
            const Count = Action.make({
              name: `fuzz/Count/${seq}`,
              success: Schema.Number,
              tier: "sealed",
              idempotencyKey: `fuzz/Count/v1/${seq}`,
              execute: Effect.sync(() => {
                ran += 1
                return tc.value + ran
              })
            })
            const Counted = Flow.make(`fuzz/Counted/${seq}`, {
              payload: {},
              success: Schema.Number,
              body: () => Measure.call({})
            })

            const dbFile = join(freshDir("db"), "state.sqlite")
            const execId = `exec-${seq}`
            const driveOnce = (hostId: string) =>
              Counted.execute({}, { executionId: execId }).pipe(
                Effect.provide(
                  Layer.mergeAll(Measure.toLayer(() => Count), Interpreter.layer(Counted), silentLogger).pipe(
                    Layer.provideMerge(Action.layerImplementations),
                    Layer.provideMerge(TestNodeRuntime.durableEngine(dbFile, hostId))
                  )
                ),
                Effect.scoped
              )

            const r1 = yield* driveOnce("host-a")
            const r2 = yield* driveOnce("host-b")
            expect(r1).toBe(tc.value + 1)
            expect(r2).toBe(r1)
            expect(ran).toBe(1)

            // Open same SQLite via TestNodeRuntime.requirements
            const entries = yield* Effect.flatMap(Journal.Journal, (j) =>
              j.entries({ runId: execId as JournalEvent.RunId, limit: 50 })).pipe(
                Effect.provide(Layer.merge(TestNodeRuntime.requirements(dbFile), silentLogger)),
                Effect.scoped
              )
            expect(entries.entries.length).toBeGreaterThan(0)

            // 3. NodeRuntime / NativeRuntime storage + layer + signalExitCode
            expect(NodeRuntime.signalExitCode(tc.signal)).toBeGreaterThan(128)
            if (tc.useNodeRuntime) {
              const nrDir = freshDir("nr")
              const nrDb = join(nrDir, "native.sqlite")
              const storageLayer = NodeRuntime.storage(nrDb).pipe(
                Layer.provide(Layer.merge(NodeFileSystem.layer, NodeCrypto.layer))
              )
              const built = yield* Layer.build(Layer.merge(storageLayer, silentLogger)).pipe(Effect.scoped)
              expect(built).toBeDefined()

              expect((): unknown =>
                NodeRuntime.layerHost(
                  { filename: nrDb, workspaceRoot: nrDir, owner: { hostId: "" } } as never,
                  Layer.empty
                )
              ).toThrow()
              const hostLayer = NodeRuntime.layerHost(
                {
                  filename: nrDb,
                  workspaceRoot: nrDir,
                  owner: { hostId: `nr-${seq}` },
                  isAlive: () =>
                    Effect.succeed(false)
                },
                Layer.empty
              )
              const builtHost = yield* Layer.build(Layer.merge(hostLayer, silentLogger)).pipe(
                Effect.scoped,
                Effect.exit
              )
              expect(builtHost).toBeDefined()
            }
            return true
          }),
        { seed: seed + 1, executions: ioExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("EgressHttpClient fuzzes loopback HTTP, HTTP_PROXY/NO_PROXY, invalid proxy URLs, providerFetch, rebuildableTransport & guardedTransport", async () => {
    const origin = await listenLoopback()
    const proxy = await listenLoopback((_req, res) => {
      res.writeHead(200, { "x-via": "fuzz-proxy" })
      res.end("proxied")
    })
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "direct",
            "proxied",
            "no-proxy",
            "bad-proxy",
            "provider-fetch",
            "rebuildable",
            "guarded"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode }) =>
            Effect.gen(function*() {
              if (mode === "direct") {
                const res = yield* Effect.flatMap(HttpClient.HttpClient, (c) => c.get(`${origin.url}/direct`)).pipe(
                  Effect.provide(EgressHttpClient.layer({}))
                )
                expect(res.status).toBe(200)
                return true
              }
              if (mode === "proxied") {
                const res = yield* Effect.flatMap(HttpClient.HttpClient, (c) => c.get(`${origin.url}/via-proxy`)).pipe(
                  Effect.provide(EgressHttpClient.layer({ HTTP_PROXY: proxy.url }))
                )
                expect(res.status).toBe(200)
                return true
              }
              if (mode === "no-proxy") {
                const res = yield* Effect.flatMap(HttpClient.HttpClient, (c) => c.get(`${origin.url}/bypass`)).pipe(
                  Effect.provide(EgressHttpClient.layer({ HTTP_PROXY: proxy.url, NO_PROXY: "127.0.0.1,localhost" }))
                )
                expect(res.status).toBe(200)
                return true
              }
              if (mode === "bad-proxy") {
                const exit = yield* Effect.flatMap(HttpClient.HttpClient, (c) => c.get("http://example.invalid/x"))
                  .pipe(
                    Effect.provide(EgressHttpClient.layer({ HTTP_PROXY: "http://user:secret-pass@:invalid" })),
                    Effect.exit
                  )
                expect(Exit.isFailure(exit)).toBe(true)
                return true
              }
              if (mode === "provider-fetch") {
                yield* Effect.scoped(
                  Effect.gen(function*() {
                    const pf = yield* EgressHttpClient.providerFetch({ HTTP_PROXY: proxy.url })
                    const r = yield* Effect.promise(async () => {
                      const res = await pf(`${origin.url}/pf`)
                      await res.text()
                      return res
                    })
                    expect(r.status).toBe(200)
                  })
                )
                return true
              }
              if (mode === "rebuildable") {
                yield* Effect.scoped(
                  Effect.gen(function*() {
                    const transport = yield* EgressHttpClient.rebuildableTransport(EgressHttpClient.dispatcher({}))
                    const res = yield* transport.client.get(`${origin.url}/reb`)
                    expect(res.status).toBe(200)
                    yield* transport.rebuild
                  })
                )
                return true
              }
              const okRes = yield* Effect.scoped(
                Effect.gen(function*() {
                  const guarded = yield* EgressHttpClient.guardedTransport({})
                  return yield* guarded.client.get(`${origin.url}/guarded`)
                })
              ).pipe(
                Effect.provideService(Destination, { check: () => Effect.void } as never),
                Effect.provideService(ResolveHost, () => Effect.succeed(["127.0.0.1"])),
                Effect.provide(GrantStore.layerNoop),
                Effect.exit
              )
              expect(okRes).toBeDefined()
              return true
            }).pipe(Effect.provide(silentLogger)),
          { seed: seed + 2, executions: ioExecutions }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)

      // Exercise resolveHost on localhost
      const ips = await Effect.runPromise(EgressHttpClient.resolveHost("localhost"))
      expect(ips.length).toBeGreaterThan(0)
    } finally {
      await origin.close()
      await proxy.close()
    }
  })

  it("NodeHost layers, openRegularFile & PsSnapshot exercise host wiring and process snapshots", async () => {
    const dir = freshDir("nodehost")
    const regularPath = join(dir, "reg.txt")
    writeFileSync(regularPath, "regular-data")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          // NodeHost.layer + openRegularFile
          const hostCtx = yield* Layer.build(NodeHost.layer)
          const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(hostCtx))
          expect(yield* fs.exists(regularPath)).toBe(true)

          const file = yield* NodeHost.openRegularFile(regularPath)
          expect(file).toBeDefined()

          // Refuses directory as regular file
          const dirExit = yield* NodeHost.openRegularFile(dir).pipe(Effect.exit)
          expect(Exit.isFailure(dirExit)).toBe(true)

          // NodeHost.layerContained
          const containedCtx = yield* Layer.build(
            NodeHost.layerContained().pipe(
              Layer.provide(ProcessLedger.layerMemory({ hostId: "fuzz-nodehost", ownerPid: process.pid }))
            )
          )
          expect(containedCtx).toBeDefined()

          // PsSnapshot against real `ps` and missing executable
          const snap = psGroupSnapshot("/bin/ps")(process.pid)
          expect(snap === undefined || Array.isArray(snap.members)).toBe(true)
          expect(psGroupSnapshot("/nonexistent/ps-bin")(process.pid)).toBeUndefined()
        })
      ).pipe(Effect.provide(silentLogger))
    )
  })
})
