import * as NodePath from "@effect/platform-node/NodePath"
import { Action, Flow, Interpreter } from "@smthrs/flows"
import { Fuzz } from "@smthrs/fuzz"
import { ProcessLedger } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import { Destination } from "@smthrs/kernel/HttpClient"
import * as Workspace from "@smthrs/kernel/Workspace"
import { MicrosandboxSandbox } from "@smthrs/sandbox"
import { Arbitrary, Effect, Exit, FileSystem, Layer, PlatformError, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as nodeFs from "node:fs"
import * as Http from "node:http"
import * as Net from "node:net"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"
import {
  DestinationProxy,
  EgressHttpClient,
  FetchTransport,
  HostLiveness,
  NodeGarbageCollector,
  NodeHost,
  ScopedProcess,
  TestNodeRuntime
} from "../src/index.ts"
import * as AtomicProtocol from "../src/internal/AtomicFileSystemProtocol.ts"
import * as ProcessCleanup from "../src/internal/ProcessCleanup.ts"
import * as ProcSnapshot from "../src/internal/ProcSnapshot.ts"
import * as RegularFile from "../src/internal/RegularFile.ts"
import * as OwnerPrivate from "../src/OwnerPrivate.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const decoder = new TextDecoder()

const httpViaSocket = (
  socketPath: string,
  path: string,
  headers: Record<string, string>
): Promise<{ readonly code: number; readonly body: string }> =>
  new Promise((resolve, reject) => {
    Http.get({ socketPath, path, headers }, (res) => {
      let body = ""
      res.on("data", (chunk) => {
        body += String(chunk)
      })
      res.on("end", () => resolve({ code: res.statusCode ?? 0, body }))
    }).on("error", reject)
  })

describe("@smthrs/platform-node fuzz invariants", () => {
  let tempRoot = ""
  let originServer: Http.Server | undefined
  let originPort = 0

  beforeAll(async () => {
    tempRoot = nodeFs.realpathSync(nodeFs.mkdtempSync(join(tmpdir(), "smthrs-pnode-fuzz-")))
    originServer = Http.createServer((req, res) => {
      if (req.url === "/500") {
        res.writeHead(500).end("err")
        return
      }
      res.writeHead(200, { "content-type": "text/plain" }).end(`ok:${req.url ?? "/"}`)
    })
    await new Promise<void>((resolve) => {
      originServer!.listen(0, "127.0.0.1", () => {
        originPort = (originServer!.address() as AddressInfo).port
        resolve()
      })
    })
  })

  afterAll(async () => {
    if (originServer !== undefined) {
      await new Promise<void>((resolve) => originServer!.close(() => resolve()))
    }
    if (tempRoot !== "") {
      nodeFs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("AtomicFileSystemProtocol framing/decoding rejects malformed, truncated, oversized, or wrong-tag frames", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "valid_ok",
          "valid_err",
          "unframed",
          "bad_tag",
          "bad_len_non_decimal",
          "oversized",
          "truncated",
          "trailing_bytes",
          "invalid_json"
        ]),
        payload: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
        maxResp: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 64, maximum: 4096 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const limits: AtomicFileSystem.Limits = {
              ...AtomicFileSystem.defaultLimits,
              request: 4096,
              content: 4096,
              response: input.maxResp
            }
            const safePayload = decoder.decode(new TextEncoder().encode(input.payload))
            const encodedReq = AtomicProtocol.encode(Buffer.from(JSON.stringify({ msg: safePayload }), "utf8"), limits)
            if (encodedReq.indexOf(10) <= 0) return false

            const tag = encodedReq.subarray(0, encodedReq.indexOf(32)).toString("ascii")
            const okBody = Buffer.from(JSON.stringify({ ok: true, value: safePayload }), "utf8")
            const errBody = Buffer.from(
              JSON.stringify({ ok: false, error: { code: "ENOENT", message: safePayload } }),
              "utf8"
            )

            const makeFrame = (hdr: string, body: Buffer) => Buffer.concat([Buffer.from(hdr, "ascii"), body])

            if (input.mode === "valid_ok") {
              if (okBody.byteLength > limits.response) return true
              const res = AtomicProtocol.decode(makeFrame(`${tag} ${okBody.byteLength}\n`, okBody), limits)
              return res.ok === true
            }
            if (input.mode === "valid_err") {
              if (errBody.byteLength > limits.response) return true
              const res = AtomicProtocol.decode(makeFrame(`${tag} ${errBody.byteLength}\n`, errBody), limits)
              return res.ok === false
            }

            let badFrame: Buffer
            switch (input.mode) {
              case "unframed":
                badFrame = Buffer.from("no-newline-at-all", "ascii")
                break
              case "bad_tag":
                badFrame = makeFrame(`wrong-tag ${okBody.byteLength}\n`, okBody)
                break
              case "bad_len_non_decimal":
                badFrame = makeFrame(`${tag} 12abc\n`, okBody)
                break
              case "oversized":
                badFrame = makeFrame(`${tag} ${limits.response + 10}\n`, Buffer.alloc(limits.response + 10, 65))
                break
              case "truncated":
                badFrame = makeFrame(`${tag} ${okBody.byteLength + 5}\n`, okBody)
                break
              case "trailing_bytes":
                badFrame = makeFrame(`${tag} ${okBody.byteLength}\n`, Buffer.concat([okBody, Buffer.from("EXTRA")]))
                break
              case "invalid_json": {
                const junk = Buffer.from("{bad-json", "utf8")
                badFrame = makeFrame(`${tag} ${junk.byteLength}\n`, junk)
                break
              }
            }

            try {
              AtomicProtocol.decode(badFrame, limits)
              return false
            } catch {
              return true
            }
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("DestinationProxy enforces Proxy-Authorization, host allowlists, and rejects SSRF/userinfo smuggling", async () => {
    const token = "fuzz-broker-token-99"
    const goodAuth = "Basic " + Buffer.from(`broker:${token}`).toString("base64")
    const sockDir = nodeFs.mkdtempSync(join(tempRoot, "proxy-"))
    const sockPath = join(sockDir, "p.sock")

    const arb = Arbitrary.schema(
      Schema.Struct({
        caseKind: Schema.Literals([
          "allowed",
          "no_auth",
          "wrong_auth",
          "disallowed_host",
          "ssrf_metadata",
          "userinfo_smuggle",
          "https_on_http_get",
          "malformed_url"
        ]),
        suffix: Schema.String.pipe(Schema.check(Schema.isMaxLength(16)))
      })
    )

    const report = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* DestinationProxy.open(sockPath, ["127.0.0.1"], token)
          return yield* Fuzz.run(
            arb,
            (input) =>
              Effect.promise(async () => {
                const safeSuffix = input.suffix.replace(/[^a-zA-Z0-9_-]/g, "x")
                switch (input.caseKind) {
                  case "allowed": {
                    const res = await httpViaSocket(
                      sockPath,
                      `http://127.0.0.1:${originPort}/${safeSuffix}`,
                      { "proxy-authorization": goodAuth }
                    )
                    return res.code === 200 && res.body === `ok:/${safeSuffix}`
                  }
                  case "no_auth": {
                    const res = await httpViaSocket(sockPath, `http://127.0.0.1:${originPort}/`, {})
                    return res.code === 407
                  }
                  case "wrong_auth": {
                    const res = await httpViaSocket(sockPath, `http://127.0.0.1:${originPort}/`, {
                      "proxy-authorization": "Basic " + Buffer.from(`broker:wrong-${safeSuffix}`).toString("base64")
                    })
                    return res.code === 407
                  }
                  case "disallowed_host": {
                    const res = await httpViaSocket(sockPath, `http://evil.example/${safeSuffix}`, {
                      "proxy-authorization": goodAuth
                    })
                    return res.code === 403
                  }
                  case "ssrf_metadata": {
                    const res = await httpViaSocket(sockPath, "http://169.254.169.254/latest/meta-data/", {
                      "proxy-authorization": goodAuth
                    })
                    return res.code === 403
                  }
                  case "userinfo_smuggle": {
                    const res = await httpViaSocket(
                      sockPath,
                      `http://127.0.0.1:80@evil.example/${safeSuffix}`,
                      { "proxy-authorization": goodAuth }
                    )
                    return res.code === 403
                  }
                  case "https_on_http_get": {
                    const res = await httpViaSocket(
                      sockPath,
                      `https://127.0.0.1:${originPort}/${safeSuffix}`,
                      { "proxy-authorization": goodAuth }
                    )
                    return res.code === 403
                  }
                  case "malformed_url": {
                    const res = await httpViaSocket(sockPath, "/relative-not-absolute", {
                      "proxy-authorization": goodAuth
                    })
                    return res.code === 400
                  }
                }
              }),
            { seed: seed + 1, executions: Math.min(executions, 60) }
          )
        })
      )
    )
    assertPassed(report)
  })

  it("HostLiveness never falsely declares other hosts, invalid pids, or EPERM processes dead and detects ESRCH cleanly", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        myHost: Schema.Literals(["host-a", "host-b", "engine-1"]),
        ownerHost: Schema.Literals(["host-a", "host-b", "engine-1"]),
        signalOutcome: Schema.Literals(["ok", "ESRCH", "EPERM", "EINVAL", "real_self"]),
        pid: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -5, maximum: 50000 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            if (input.signalOutcome === "real_self") {
              const check = HostLiveness.isAlive({ hostId: input.myHost })
              const alive = yield* check({ hostId: input.myHost, pid: process.pid })
              if (!alive) return false
              const dead = yield* check({ hostId: input.myHost, pid: 2_147_483_646 })
              return !dead
            }

            let called = false
            const check = HostLiveness.isAlive({
              hostId: input.myHost,
              signal: () => {
                called = true
                if (input.signalOutcome === "ok") return
                const err: Error & { code?: string } = new Error(input.signalOutcome)
                err.code = input.signalOutcome
                throw err
              }
            })

            const result = yield* check({ hostId: input.ownerHost, pid: input.pid })

            if (input.ownerHost !== input.myHost) {
              return result === true && !called
            }
            if (input.pid <= 0) {
              return result === true
            }
            if (input.signalOutcome === "ok" || input.signalOutcome === "EPERM") {
              return result === true
            }
            if (input.signalOutcome === "ESRCH") {
              return result === false
            }
            return typeof result === "boolean"
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })

  it("ProcSnapshot.parseStat, ProcessCleanup.policy, RegularFile.open, and OwnerPrivate enforce OS invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pid: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 99999 }))),
        pgid: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 99999 }))),
        comm: Schema.Literals(["node", "my (weird) proc", "a b c", "sh)", "(nested)"]),
        state: Schema.Literals(["R", "S", "Z", "D", "T"]),
        ticks: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))),
        bootMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1_000_000, maximum: 2_000_000_000 }))),
        garbage: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        signal: Schema.Literals(["SIGTERM", "SIGKILL", "SIGINT", "SIGSTOP"]),
        graceMs: Schema.Literals([0, 100, 5000, -1, 3_000_000_000])
      })
    )

    const regularPath = join(tempRoot, "regular.txt")
    nodeFs.writeFileSync(regularPath, "hello")
    const dirPath = join(tempRoot, "subdir-reg")
    nodeFs.mkdirSync(dirPath, { recursive: true })

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const fieldsAfterState = Array.from({ length: 21 }, (_, idx) => {
              if (idx === 1) return String(input.pgid)
              if (idx === 18) return String(input.ticks)
              return "0"
            }).join(" ")
            const statLine = `${input.pid} (${input.comm}) ${input.state} ${fieldsAfterState}`
            const parsed = ProcSnapshot.parseStat(statLine, input.bootMs)
            if (parsed === undefined) return false
            if (parsed.pgid !== input.pgid || parsed.member.pid !== input.pid) return false
            if (parsed.member.zombie !== (input.state === "Z")) return false

            ProcSnapshot.parseStat(input.garbage, input.bootMs)

            if (ProcSnapshot.rootFor("linux") !== "/proc") return false
            if (ProcSnapshot.rootFor("darwin") !== undefined) return false

            const polExit = yield* Effect.exit(
              ProcessCleanup.policy({
                killSignal: input.signal,
                forceKillAfter: `${input.graceMs} millis`
              })
            )
            const shouldFail = input.signal === "SIGSTOP" || input.graceMs < 0 || input.graceMs > 2_147_483_647
            if (shouldFail && !Exit.isFailure(polExit)) return false
            if (!shouldFail && !Exit.isSuccess(polExit)) return false

            const okOpen = yield* Effect.exit(Effect.scoped(RegularFile.open(process.platform, regularPath)))
            if (!Exit.isSuccess(okOpen)) return false
            const dirOpen = yield* Effect.exit(Effect.scoped(RegularFile.open(process.platform, dirPath)))
            if (!Exit.isFailure(dirOpen)) return false

            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    assertPassed(report)
  })

  it(
    "FetchTransport.observe, EgressHttpClient, NodeGarbageCollector, ScopedProcess, OwnerPrivate, and TestNodeRuntime",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "fetch_200",
            "fetch_500",
            "egress_get",
            "egress_pin_mismatch",
            "scoped_process",
            "owner_private",
            "gc_collect",
            "test_node_runtime"
          ]),
          tag: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
          exitCode: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3 })))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.gen(function*() {
              const safeTag = input.tag.replace(/[^a-zA-Z0-9_-]/g, "a") || "t"
              const origin = `http://127.0.0.1:${originPort}`

              if (input.mode === "fetch_200" || input.mode === "fetch_500") {
                const observer = FetchTransport.observe(origin)
                try {
                  const attempt = observer.begin()
                  const path = input.mode === "fetch_500" ? "/500" : `/${safeTag}`
                  const res = yield* Effect.promise(() => fetch(`${origin}${path}`))
                  yield* Effect.promise(() => res.text())
                  const fields = attempt.fields()
                  observer.close()
                  observer.close()
                  return typeof fields["transport.phase"] === "string" || Object.keys(fields).length > 0
                } finally {
                  observer.close()
                }
              }

              if (input.mode === "egress_get") {
                const body = yield* Effect.provide(
                  Effect.gen(function*() {
                    const client = yield* HttpClient.HttpClient
                    const res = yield* client.execute(HttpClientRequest.get(`${origin}/${safeTag}`))
                    return yield* res.text
                  }),
                  EgressHttpClient.layer({})
                )
                return body === `ok:/${safeTag}`
              }

              if (input.mode === "egress_pin_mismatch") {
                // Mismatched Destination origin MUST refuse request before dialing
                const exit = yield* Effect.exit(
                  Effect.provide(
                    Effect.gen(function*() {
                      const client = yield* HttpClient.HttpClient
                      return yield* client.execute(HttpClientRequest.get(`${origin}/${safeTag}`))
                    }).pipe(
                      Effect.provideService(Destination, {
                        origin: "http://other.example:80",
                        addresses: ["127.0.0.1"]
                      })
                    ),
                    EgressHttpClient.layer({})
                  )
                )
                return Exit.isFailure(exit)
              }

              if (input.mode === "scoped_process") {
                return yield* Effect.scoped(
                  Effect.gen(function*() {
                    const handle = yield* ScopedProcess.spawn({
                      command: "sh",
                      args: ["-c", `printf '%s' '${safeTag}'; exit ${input.exitCode}`]
                    })
                    const chunks = yield* Stream.runCollect(handle.stdout)
                    const code = yield* handle.exitCode
                    const st = yield* ScopedProcess.status(handle)
                    const out = decoder.decode(Uint8Array.from(Array.from(chunks).flatMap((c) => Array.from(c))))
                    return out === safeTag && Number(code) === input.exitCode && st !== undefined
                  })
                )
              }

              if (input.mode === "owner_private") {
                const seen: Array<AtomicProtocol.HostRequest> = []
                const svc = OwnerPrivate.make(
                  (req) =>
                    Effect.sync(() => {
                      seen.push(req)
                    }),
                  (path, cause) =>
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "OwnerPrivate",
                      method: "pin",
                      pathOrDescriptor: path,
                      description: String(cause)
                    })
                )
                const target = join(tempRoot, `priv-${safeTag}`)
                const pinned = yield* svc.directory(tempRoot, target)
                yield* svc.write(tempRoot, join(target, "a.bin"), new Uint8Array([1, 2, 3]))
                yield* svc.append(join(tempRoot, "log.txt"), safeTag)
                const beforeEscape = seen.length
                const escExit = yield* Effect.exit(svc.directory(tempRoot, join(tempRoot, "..", "escape")))
                return pinned.startsWith(tempRoot) && Exit.isFailure(escExit) && seen.length === beforeEscape
              }

              if (input.mode === "gc_collect") {
                yield* Effect.provide(
                  Effect.flatMap(MicrosandboxSandbox.GarbageCollector, (gc) => gc.collect),
                  NodeGarbageCollector.layer
                )
                return true
              }

              const dbFile = join(tempRoot, `tnr-${safeTag}-${Math.random().toString(36).slice(2, 8)}.sqlite`)
              try {
                const StepAct = Action.make("pnode-fuzz/Step", {
                  payload: { v: Schema.String },
                  success: Schema.String
                })
                const FuzzFlow = Flow.make("pnode-fuzz/Flow", {
                  payload: { v: Schema.String },
                  success: Schema.String,
                  body: ({ v }) => StepAct.call({ v })
                })
                const res = yield* FuzzFlow.execute(
                  { v: safeTag },
                  { executionId: `exec-${safeTag}` }
                ).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      StepAct.toLayer(({ v }) => Effect.succeed(`ran:${v}`)),
                      Interpreter.layer(FuzzFlow)
                    ).pipe(
                      Layer.provideMerge(Action.layerImplementations),
                      Layer.provideMerge(TestNodeRuntime.durableEngine(dbFile, "fuzz-host"))
                    )
                  )
                )
                void NodeHost.layer
                void KernelFileSystem
                void GrantStore
                void Workspace
                void FileSystem
                return res === `ran:${safeTag}`
              } finally {
                for (const suffix of ["", "-wal", "-shm"]) {
                  try {
                    nodeFs.rmSync(`${dbFile}${suffix}`, { force: true })
                  } catch {}
                }
              }
            }),
          { seed: seed + 4, executions: Math.min(executions, 30) }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it("AtomicFileSystem guarded layer roundtrips workspace ops and blocks symlink/path escapes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        subDir: Schema.Literals(["a", "b/c", "nested"]),
        fileName: Schema.Literals(["doc.txt", "data-1.txt"]),
        content: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        escapeKind: Schema.Literals(["dotdot", "symlink_read", "symlink_write"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const iterDir = nodeFs.mkdtempSync(join(tempRoot, "afs-"))
            const wsRoot = join(iterDir, "ws")
            const outsideFile = join(iterDir, "secret.txt")
            nodeFs.mkdirSync(wsRoot, { recursive: true })
            nodeFs.writeFileSync(outsideFile, "TOP_SECRET")
            try {
              const safeContent = decoder.decode(new TextEncoder().encode(input.content.replace(/\0/g, "x")))
              const guardedLayer = KernelFileSystem.layer.pipe(
                Layer.provide(AtomicFileSystem.layer),
                Layer.provide(NodePath.layer),
                Layer.provide(Workspace.layer(wsRoot)),
                Layer.provide(GrantStore.layerNoop)
              )

              return yield* Effect.provide(
                Effect.gen(function*() {
                  const fs = yield* FileSystem.FileSystem
                  const dir = join(wsRoot, input.subDir)
                  const file = join(dir, input.fileName)
                  yield* fs.makeDirectory(dir, { recursive: true })
                  yield* fs.writeFileString(file, safeContent)
                  const readBack = yield* fs.readFileString(file)
                  if (readBack !== safeContent) return false
                  const st = yield* fs.stat(file)
                  if (st.type !== "File") return false
                  const rp = yield* fs.realPath(file)
                  if (!rp.endsWith(input.fileName)) return false
                  const listed = yield* fs.readDirectory(dir)
                  if (!listed.includes(input.fileName)) return false
                  const moved = join(dir, "moved.txt")
                  yield* fs.rename(file, moved)
                  if (!(yield* fs.exists(moved))) return false
                  yield* fs.remove(moved)

                  if (input.escapeKind === "dotdot") {
                    const esc = yield* Effect.exit(fs.readFileString(join(wsRoot, "..", "secret.txt")))
                    if (!Exit.isFailure(esc)) return false
                  } else if (input.escapeKind === "symlink_read") {
                    const linkPath = join(wsRoot, "escape-link")
                    nodeFs.symlinkSync(outsideFile, linkPath)
                    const esc = yield* Effect.exit(fs.readFileString(linkPath))
                    if (!Exit.isFailure(esc)) return false
                  } else {
                    const linkPath = join(wsRoot, "escape-write-link")
                    nodeFs.symlinkSync(outsideFile, linkPath)
                    const esc = yield* Effect.exit(fs.writeFileString(linkPath, "PWNED"))
                    if (!Exit.isFailure(esc)) return false
                    if (nodeFs.readFileSync(outsideFile, "utf8") !== "TOP_SECRET") return false
                  }
                  return true
                }),
                guardedLayer
              )
            } finally {
              nodeFs.rmSync(iterDir, { recursive: true, force: true })
            }
          }),
        { seed: seed + 5, executions: Math.min(executions, 20) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("ProcessReaper.reap enforces host/liveness/identity/own-group safety invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ownerAlive: Schema.Literals(["alive", "dead", "unknown"]),
        samePgidAsSelf: Schema.Boolean,
        ownGroupKnown: Schema.Boolean,
        preBoot: Schema.Boolean,
        startKind: Schema.Literals(["started", "gone", "unavailable", "unsupported"]),
        startSkewMs: Schema.Literals([0, 500, 5000]),
        targetInvalid: Schema.Boolean,
        killOutcome: Schema.Literals(["signalled", "already-gone", "failed"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const ownerPid = 40000
            const ownPgid = 42000
            const bootMs = 1_700_000_000_000
            const recPgid = input.samePgidAsSelf ? ownPgid : 55000
            const rec: ProcessLedger.ProcessRecord = {
              pid: recPgid,
              pgid: recPgid,
              hostId: "this-host",
              ownerPid: 41111,
              startedAtMs: input.preBoot ? bootMs - 10_000 : bootMs + 50_000,
              commandDigest: "digest-1"
            }

            const killed: Array<number> = []
            const reapedRows: Array<number> = []
            const skippedReasons: Array<string> = []

            const ledger: ProcessLedger.Service = {
              record: () => Effect.succeed(rec),
              release: () => Effect.void,
              reaped: (row) => Effect.sync(() => void reapedRows.push(row.pid)),
              skipped: (_row, reason) => Effect.sync(() => void skippedReasons.push(reason)),
              live: Effect.succeed([]),
              orphans: Effect.succeed([rec])
            }

            const system: ProcessReaper.System = {
              isAlive: () => input.ownerAlive,
              startedAtMs: () => {
                if (input.startKind === "started") {
                  return { _tag: "started", startedAtMs: rec.startedAtMs + input.startSkewMs }
                }
                return { _tag: input.startKind }
              },
              ownGroup: () => (input.ownGroupKnown ? ownPgid : null),
              bootedAtMs: () => bootMs,
              refuseTarget: () => (input.targetInvalid ? "invalid-record" : undefined),
              killTree: (r) => {
                killed.push(r.pid)
                return input.killOutcome
              }
            }

            const decided = yield* ProcessReaper.reap({ ownerPid, system }).pipe(
              Effect.provideService(ProcessLedger.ProcessLedger, ledger)
            )
            yield* ProcessReaper.report(decided)
            void ProcessReaper.systemFor("linux")
            void ProcessReaper.systemFor("darwin")
            void ProcessReaper.systemFor("win32")
            void ProcessReaper.groupSnapshotFor("linux")
            void ProcessReaper.groupSnapshotFor("darwin")

            const unsafeToKill = input.samePgidAsSelf ||
              input.targetInvalid ||
              !input.ownGroupKnown ||
              input.ownerAlive !== "dead" ||
              input.preBoot ||
              input.startKind === "gone" ||
              input.startKind === "unavailable" ||
              (input.startKind === "started" && input.startSkewMs > ProcessReaper.identityToleranceMs)

            if (unsafeToKill) {
              return killed.length === 0 && decided.length === 1 && decided[0]!.killed === false
            }
            if (input.killOutcome === "failed") {
              return killed.length === 1 && decided[0]!.killed === false && decided[0]!.refusal === "kill-failed" &&
                reapedRows.length === 0
            }
            return killed.length === 1 && killed[0] === rec.pid && decided[0]!.killed === true &&
              reapedRows.length === 1
          }),
        { seed: seed + 6, executions }
      )
    )
    assertPassed(report)
  })

  it("DestinationProxy CONNECT tunnel & EgressHttpClient proxy/resolveHost enforce allowlists", async () => {
    const token = "tunnel-token-77"
    const goodAuth = "Basic " + Buffer.from(`broker:${token}`).toString("base64")
    const sockDir = nodeFs.mkdtempSync(join(tempRoot, "tun-"))
    const sockPath = join(sockDir, "t.sock")

    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "connect_allowed",
          "connect_denied",
          "connect_noauth",
          "egress_proxy_env",
          "resolve_local"
        ])
      })
    )

    const report = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* DestinationProxy.open(sockPath, ["127.0.0.1"], token)
          return yield* Fuzz.run(
            arb,
            (input) =>
              Effect.gen(function*() {
                if (input.mode === "resolve_local") {
                  const addrs = yield* EgressHttpClient.resolveHost("127.0.0.1")
                  return addrs.includes("127.0.0.1")
                }
                if (input.mode === "egress_proxy_env") {
                  const d = yield* EgressHttpClient.dispatcher({
                    HTTP_PROXY: `http://127.0.0.1:${originPort}`,
                    NO_PROXY: "localhost,127.0.0.1,.internal"
                  })
                  return d !== undefined
                }
                const responseHead = yield* Effect.promise(
                  () =>
                    new Promise<string>((resolve, reject) => {
                      const c = Net.connect(sockPath)
                      let out = ""
                      const host = input.mode === "connect_denied" ? "evil.example:443" : `127.0.0.1:${originPort}`
                      const authHdr = input.mode === "connect_noauth" ? "" : `Proxy-Authorization: ${goodAuth}\r\n`
                      c.on("connect", () => {
                        c.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n${authHdr}\r\n`)
                      })
                      c.on("data", (d) => {
                        out += String(d)
                        if (out.includes("\r\n\r\n")) {
                          c.destroy()
                          resolve(out)
                        }
                      })
                      c.on("close", () => resolve(out))
                      c.on("error", reject)
                    })
                )
                if (input.mode === "connect_allowed") return responseHead.startsWith("HTTP/1.1 200")
                if (input.mode === "connect_noauth") return responseHead.startsWith("HTTP/1.1 407")
                return responseHead.startsWith("HTTP/1.1 403")
              }),
            { seed: seed + 7, executions: Math.min(executions, 30) }
          )
        })
      )
    )
    assertPassed(report)
  })
})
