import { Fuzz } from "@smthrs/fuzz"
import { ProcessLedger } from "@smthrs/kernel"
import { Arbitrary, Effect, Exit, Layer, Redacted, Schema } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import * as Http from "node:http"
import * as Net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import * as DestinationProxy from "../src/DestinationProxy.ts"
import * as FetchTransport from "../src/FetchTransport.ts"
import * as PipedProcess from "../src/internal/PipedProcess.ts"
import * as ProcessSupervisor from "../src/internal/ProcessSupervisor.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import * as ScopedProcess from "../src/ScopedProcess.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261128")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const httpOverSocket = (socketPath: string, path: string, auth?: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    Http.get(
      {
        socketPath,
        path,
        headers: auth !== undefined ? { "proxy-authorization": auth } : {}
      },
      (res) => {
        let body = ""
        res.on("data", (c) => {
          body += String(c)
        })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      }
    ).on("error", reject)
  })

const connectOverSocket = (socketPath: string, authority: string, auth?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const sock = Net.connect(socketPath)
    let out = ""
    sock.on("error", reject)
    sock.on("data", (d) => {
      out += d.toString("utf8")
      if (out.includes("\r\n\r\n")) {
        sock.destroy()
        resolve(out)
      }
    })
    sock.on("close", () => resolve(out))
    sock.on("connect", () => {
      const headers = auth !== undefined ? `Proxy-Authorization: ${auth}\r\n` : ""
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${headers}\r\n`)
    })
  })

describe("@smthrs/platform-node Wave 7 deep fuzz (ProcessReaper, DestinationProxy, PipedProcess, ScopedProcess, FetchTransport, ProcessConfinement, ProcessSupervisor)", () => {
  it("ProcessReaper.reap enforces every refusal and kill outcome across all safety boundaries", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "ownerAlive",
          "noGroup",
          "ownGroup",
          "ownGroupUnknown",
          "invalidRecord",
          "preBoot",
          "processGone",
          "identityMismatch",
          "identityUnverified",
          "killSuccess",
          "killAlreadyGone",
          "killFailed"
        ]),
        pidOffset: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 9000 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scenario, pidOffset }) =>
          Effect.gen(function*() {
            const bootMs = 1_700_000_000_000
            const startedAtMs = scenario === "preBoot" ? bootMs - 10_000 : bootMs + 50_000
            const pid = 20_000 + pidOffset
            const pgid = scenario === "noGroup" ? null : scenario === "ownGroup" ? 4242 : pid
            const ownerPid = 10_000 + pidOffset
            const record: ProcessLedger.ProcessRecord = {
              pid,
              pgid,
              hostId: "wave7-host",
              ownerPid,
              startedAtMs,
              commandDigest: `cmd-${scenario}`
            }

            const reaped: Array<number> = []
            const skipped: Array<string> = []
            const ledger: ProcessLedger.Service = {
              record: () => Effect.succeed(record),
              release: () => Effect.void,
              reaped: (row) => Effect.sync(() => void reaped.push(row.pid)),
              skipped: (_row, reason) => Effect.sync(() => void skipped.push(reason)),
              live: Effect.succeed([]),
              orphans: Effect.succeed([record])
            }

            const system: ProcessReaper.System = {
              isAlive: (p) => {
                if (p === ownerPid) return scenario === "ownerAlive" ? "alive" : "dead"
                return scenario === "processGone" ? "dead" : "alive"
              },
              startedAtMs: () => {
                if (scenario === "processGone") return { _tag: "gone" }
                if (scenario === "identityUnverified") return { _tag: "unavailable" }
                if (scenario === "identityMismatch") return { _tag: "started", startedAtMs: startedAtMs + 60_000 }
                return { _tag: "started", startedAtMs }
              },
              ownGroup: () => (scenario === "ownGroupUnknown" ? null : 4242),
              bootedAtMs: () => bootMs,
              refuseTarget: () => (scenario === "noGroup"
                ? "no-group"
                : scenario === "invalidRecord"
                ? "invalid-record"
                : undefined),
              killTree: () =>
                scenario === "killFailed" ? "failed" : scenario === "killAlreadyGone" ? "already-gone" : "signalled"
            }

            const outcomes = yield* ProcessReaper.reap({ ownerPid: 99_999, system }).pipe(
              Effect.provide(Layer.succeed(ProcessLedger.ProcessLedger, ledger))
            )
            expect(outcomes.length).toBe(1)
            const first = outcomes[0]!
            if (scenario === "killSuccess" || scenario === "killAlreadyGone") {
              expect(first.killed).toBe(true)
              expect(reaped).toEqual([pid])
            } else {
              expect(first.killed).toBe(false)
              expect(reaped).toEqual([])
            }

            // Also touch real platform system constructors
            expect(typeof ProcessReaper.systemFor("linux").bootedAtMs()).toBe("number")
            expect(typeof ProcessReaper.systemFor("darwin").bootedAtMs()).toBe("number")
            expect(typeof ProcessReaper.systemFor("win32").bootedAtMs()).toBe("number")
            expect(typeof ProcessReaper.groupSnapshotFor("linux")).toBe("function")
            return true
          }),
        { executions: Math.min(executions, 90), seed }
      )
    )
    assertPassed(report)
  }, 45_000)

  it.skipIf(process.platform === "win32")(
    "DestinationProxy.open enforces proxy auth, destination allowlist, HTTP forwarding, and CONNECT tunneling",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "httpAllowed",
            "httpDeniedHost",
            "httpMissingAuth",
            "httpWrongAuth",
            "httpUserInfoDenied",
            "connectAllowed",
            "connectDeniedHost",
            "connectMissingAuth",
            "connectBadAuthority"
          ]),
          token: Schema.Literals(["tok-alpha-1", "tok-beta-2"])
        })
      )

      const upstream = Http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end(`ok:${req.url}`)
      })
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()))
      const addr = upstream.address()
      const port = typeof addr === "object" && addr !== null ? addr.port : 0

      try {
        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ mode, token }) =>
              Effect.gen(function*() {
                const dir = mkdtempSync(join(tmpdir(), "dp-"))
                const sock = join(dir, "proxy.sock")
                const goodAuth = "Basic " + Buffer.from(`broker:${token}`).toString("base64")
                const wrongAuth = "Basic " + Buffer.from("broker:wrong-token").toString("base64")
                try {
                  yield* Effect.scoped(
                    Effect.gen(function*() {
                      yield* DestinationProxy.open(sock, [`127.0.0.1:${port}`], token)
                      if (mode === "httpAllowed") {
                        const res = yield* Effect.promise(() =>
                          httpOverSocket(sock, `http://127.0.0.1:${port}/ping`, goodAuth)
                        )
                        expect(res.status).toBe(200)
                        expect(res.body).toBe("ok:/ping")
                      } else if (mode === "httpDeniedHost") {
                        const res = yield* Effect.promise(() =>
                          httpOverSocket(sock, "http://blocked.example.com/", goodAuth)
                        )
                        expect(res.status).toBe(403)
                      } else if (mode === "httpMissingAuth") {
                        const res = yield* Effect.promise(() => httpOverSocket(sock, `http://127.0.0.1:${port}/ping`))
                        expect(res.status).toBe(407)
                      } else if (mode === "httpWrongAuth") {
                        const res = yield* Effect.promise(() =>
                          httpOverSocket(sock, `http://127.0.0.1:${port}/ping`, wrongAuth)
                        )
                        expect(res.status).toBe(407)
                      } else if (mode === "httpUserInfoDenied") {
                        const res = yield* Effect.promise(() =>
                          httpOverSocket(sock, `http://user:pass@127.0.0.1:${port}/`, goodAuth)
                        )
                        expect(res.status).toBe(403)
                      } else if (mode === "connectAllowed") {
                        const out = yield* Effect.promise(() => connectOverSocket(sock, `127.0.0.1:${port}`, goodAuth))
                        expect(out).toContain("200")
                      } else if (mode === "connectDeniedHost") {
                        const out = yield* Effect.promise(() =>
                          connectOverSocket(sock, "blocked.example.com:443", goodAuth)
                        )
                        expect(out).toContain("403")
                      } else if (mode === "connectMissingAuth") {
                        const out = yield* Effect.promise(() => connectOverSocket(sock, `127.0.0.1:${port}`))
                        expect(out).toContain("407")
                      } else {
                        const out = yield* Effect.promise(() =>
                          connectOverSocket(sock, "not-a-valid-authority", goodAuth)
                        )
                        expect(out).toMatch(/400|403/)
                      }
                    })
                  )
                  return true
                } finally {
                  rmSync(dir, { recursive: true, force: true })
                }
              }),
            { executions: Math.min(executions, 35), seed: seed + 1 }
          )
        )
        assertPassed(report)
      } finally {
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
      }
    },
    60_000
  )

  it(
    "PipedProcess.spawn/refuseNul/failure, ScopedProcess.spawn/status, FetchTransport.observe, ProcessConfinement & ProcessSupervisor helpers",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "nulInCommand",
            "nulInArg",
            "nulInCwd",
            "nulInEnvVal",
            "injectedSpawnError",
            "injectedThrow",
            "realEchoAndExit",
            "scopedSpawnStatus",
            "fetchTransportObserve",
            "supervisorAndConfinement"
          ]),
          exitCode: Schema.Literals([0, 1, 42]),
          errCode: Schema.Literals(["ENOENT", "EACCES", "EAGAIN", "UNKNOWN"])
        })
      )

      const upstream = Http.createServer((_req, res) => {
        res.writeHead(200)
        res.end("pong")
      })
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()))
      const addr = upstream.address()
      const port = typeof addr === "object" && addr !== null ? addr.port : 0

      try {
        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ mode, exitCode, errCode }) =>
              Effect.gen(function*() {
                if (mode === "nulInCommand") {
                  const ex = yield* PipedProcess.refuseNul(ChildProcess.make("bad\0cmd", [])).pipe(Effect.exit)
                  expect(Exit.isFailure(ex)).toBe(true)
                } else if (mode === "nulInArg") {
                  const ex = yield* PipedProcess.refuseNul(ChildProcess.make("echo", ["ok", "bad\0arg"])).pipe(
                    Effect.exit
                  )
                  expect(Exit.isFailure(ex)).toBe(true)
                } else if (mode === "nulInCwd") {
                  const ex = yield* PipedProcess.refuseNul(ChildProcess.make("echo", [Redacted.make("secret\0val")]))
                    .pipe(Effect.exit)
                  expect(Exit.isFailure(ex)).toBe(true)
                } else if (mode === "nulInEnvVal") {
                  const ex = yield* PipedProcess.refuseNul(ChildProcess.make("echo", [], { env: { X: "a\0b" } })).pipe(
                    Effect.exit
                  )
                  expect(Exit.isFailure(ex)).toBe(true)
                } else if (mode === "injectedSpawnError") {
                  const faulty: PipedProcess.NativeSpawn = () => {
                    const child = Object.assign(new EventEmitter(), {
                      pid: undefined,
                      stdin: new PassThrough(),
                      stdout: new PassThrough(),
                      stderr: new PassThrough(),
                      kill: () => true
                    })
                    queueMicrotask(() =>
                      child.emit("error", Object.assign(new Error(`err:${errCode}`), { code: errCode }))
                    )
                    return child as never
                  }
                  const ex = yield* Effect.scoped(PipedProcess.spawn(ChildProcess.make("echo", ["hi"]), false)).pipe(
                    Effect.provideService(PipedProcess.NativeSpawn, faulty),
                    Effect.exit
                  )
                  expect(Exit.isFailure(ex)).toBe(true)
                } else if (mode === "injectedThrow") {
                  const throwing: PipedProcess.NativeSpawn = () => {
                    throw Object.assign(new Error(`sync:${errCode}`), { code: errCode })
                  }
                  const ex = yield* Effect.scoped(PipedProcess.spawn(ChildProcess.make("echo", ["hi"]), false)).pipe(
                    Effect.provideService(PipedProcess.NativeSpawn, throwing),
                    Effect.exit
                  )
                  expect(Exit.isFailure(ex)).toBe(true)
                  const fErr = PipedProcess.failure("spawn", Object.assign(new Error("boom"), { code: errCode }))
                  expect(fErr._tag).toBe("PlatformError")
                } else if (mode === "realEchoAndExit") {
                  yield* Effect.scoped(
                    Effect.gen(function*() {
                      const handle = yield* PipedProcess.spawn(
                        ChildProcess.make(process.execPath, [
                          "-e",
                          `process.stdout.write("hi"); process.exit(${exitCode})`
                        ]),
                        false
                      )
                      expect(PipedProcess.standardFdsOf(handle)).toBeUndefined()
                      const code = yield* handle.exitCode
                      expect(Number(code)).toBe(exitCode)
                    })
                  )
                } else if (mode === "scopedSpawnStatus") {
                  yield* Effect.scoped(
                    Effect.gen(function*() {
                      const handle = yield* ScopedProcess.spawn({
                        command: process.execPath,
                        args: ["-e", `process.exit(${exitCode})`]
                      })
                      const st = yield* ScopedProcess.status(handle)
                      expect(st.code).toBe(exitCode)
                    })
                  )
                } else if (mode === "fetchTransportObserve") {
                  const origin = `http://127.0.0.1:${port}`
                  const obs = FetchTransport.observe(origin)
                  try {
                    const att = obs.begin()
                    const body = yield* Effect.promise(() =>
                      att.run(async () => {
                        const r = await fetch(`${origin}/ping`)
                        return await r.text()
                      })
                    )
                    expect(body).toBe("pong")
                    const fields = att.fields()
                    expect(typeof fields).toBe("object")
                  } finally {
                    obs.close()
                    obs.close()
                  }
                  // After close, begin() still returns an attempt safely
                  const after = obs.begin()
                  expect(typeof after.fields()).toBe("object")
                } else {
                  const args1 = yield* ProcessSupervisor.bootstrapArguments({
                    bun: false,
                    main: "/app/main.js",
                    sea: false
                  })
                  const args2 = yield* ProcessSupervisor.bootstrapArguments({
                    bun: true,
                    main: "/app/main.js",
                    sea: false
                  })
                  const args3Ex = yield* ProcessSupervisor.bootstrapArguments({
                    bun: false,
                    main: "/app/main.js",
                    sea: true
                  }).pipe(Effect.exit)
                  expect(Array.isArray(args1)).toBe(true)
                  expect(Array.isArray(args2)).toBe(true)
                  expect(Exit.isFailure(args3Ex)).toBe(true)
                  expect(ProcessSupervisor.runtimeDescription({ bun: false, main: "/app/main.js" })).toBeDefined()
                  const supErr = ProcessSupervisor.failure(
                    "spawn",
                    "echo",
                    Object.assign(new Error("fail"), { code: errCode })
                  )
                  expect(supErr._tag).toBe("PlatformError")
                  const conf = ProcessConfinement.make()
                  expect(typeof conf).toBe("object")
                }
                return true
              }),
            { executions: Math.min(executions, 45), seed: seed + 2 }
          )
        )
        assertPassed(report)
      } finally {
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
      }
    },
    60_000
  )
})
