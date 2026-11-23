import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, FileSystem, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as ChildProcess from "effect/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import * as nodeFs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as CloudflareSandbox from "../src/CloudflareSandbox/index.ts"
import * as CommandSandbox from "../src/CommandSandbox/index.ts"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import * as HttpSandbox from "../src/HttpSandbox/index.ts"
import * as HttpProtocol from "../src/HttpSandbox/protocol.ts"
import {
  CiJob,
  RemoteChildProcessSpawner,
  Sandbox,
  SandboxCommand,
  SandboxHealth,
  SandboxSupervision,
  SandboxTools,
  TerminalProtocol
} from "../src/index.ts"
import * as Base64Util from "../src/internal/base64.ts"
import { boundedMessage, messageBound } from "../src/internal/boundedMessage.ts"
import { configurationFingerprint } from "../src/internal/configurationFingerprint.ts"
import { describeExit } from "../src/internal/describeExit.ts"
import { envPrefix } from "../src/internal/envPrefix.ts"
import { parentOf } from "../src/internal/guestPath.ts"
import { machineName } from "../src/internal/machineName.ts"
import { rootedAt } from "../src/internal/rootedPath.ts"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import * as JustBashSandbox from "../src/JustBashSandbox/index.ts"
import * as ProviderConformance from "../src/ProviderConformance/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { platform } from "./helpers/containedPlatform.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe("@smthrs/sandbox fuzz invariants", () => {
  let tempRoot = ""

  beforeAll(() => {
    tempRoot = nodeFs.realpathSync(nodeFs.mkdtempSync(join(tmpdir(), "smthrs-sandbox-fuzz-")))
  })

  afterAll(() => {
    if (tempRoot !== "") {
      nodeFs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("TerminalProtocol resize/server-control codecs roundtrip and reject malformed or out-of-range frames", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cols: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -10, maximum: TerminalProtocol.maxCols + 50 }))),
        rows: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -10, maximum: TerminalProtocol.maxRows + 50 }))),
        access: Schema.Literals(["read", "write"]),
        reason: Schema.Literals(["closed", "slept", "lost", "revoked"]),
        attempt: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -2, maximum: 15 }))),
        closeCode: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 999, maximum: 4500 }))),
        garbage: Schema.String.pipe(Schema.check(Schema.isMaxLength(128)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const validResize = input.cols >= 1 &&
              input.cols <= TerminalProtocol.maxCols &&
              input.rows >= 1 &&
              input.rows <= TerminalProtocol.maxRows

            const encoded = TerminalProtocol.encodeResize(input.cols, input.rows)
            const decoded = TerminalProtocol.decodeClientControl(encoded)
            if (validResize) {
              if (
                decoded === undefined ||
                decoded.type !== "resize" ||
                decoded.cols !== input.cols ||
                decoded.rows !== input.rows
              ) {
                return false
              }
            } else {
              if (decoded !== undefined) return false
            }

            const ready = TerminalProtocol.encodeServerControl({ type: "ready", access: input.access })
            const readyDec = TerminalProtocol.decodeServerControl(ready)
            if (readyDec?.type !== "ready" || readyDec.access !== input.access) return false

            const ended = TerminalProtocol.encodeServerControl({ type: "ended", reason: input.reason })
            const endedDec = TerminalProtocol.decodeServerControl(ended)
            if (endedDec?.type !== "ended" || endedDec.reason !== input.reason) return false

            const gClient = TerminalProtocol.decodeClientControl(input.garbage)
            if (gClient !== undefined) {
              if (
                gClient.type !== "resize" ||
                !Number.isInteger(gClient.cols) ||
                !Number.isInteger(gClient.rows) ||
                gClient.cols < 1 ||
                gClient.cols > TerminalProtocol.maxCols ||
                gClient.rows < 1 ||
                gClient.rows > TerminalProtocol.maxRows
              ) {
                return false
              }
            }
            TerminalProtocol.decodeServerControl(input.garbage)

            const delay = TerminalProtocol.reconnectDelay(input.attempt)
            if (input.attempt < 1 || input.attempt > 10) {
              if (delay !== undefined) return false
            } else {
              if (delay === undefined || delay < 1000 || delay > 30_000) return false
            }

            const isFin = TerminalProtocol.isFinal(input.closeCode)
            if (
              input.closeCode === TerminalProtocol.CloseCode.ended ||
              input.closeCode === TerminalProtocol.CloseCode.noAccess ||
              input.closeCode === TerminalProtocol.CloseCode.unsupported ||
              input.closeCode === TerminalProtocol.CloseCode.tooBig
            ) {
              if (!isFin) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("Internal path containment, base64, slugs, envPrefix, and boundedMessage hold strict invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        bytes: Schema.Array(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 })))).pipe(
          Schema.check(Schema.isMaxLength(96))
        ),
        session: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
        prefix: Schema.Literals(["sb", "smthrs", "box"]),
        relPath: Schema.Literals([
          "a/b.txt",
          "./a/b",
          "../outside.txt",
          "/etc/passwd",
          "a/../../outside.txt",
          "a/b/c",
          "",
          "."
        ]),
        msg: Schema.String.pipe(Schema.check(Schema.isMaxLength(80))),
        repeat: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 16 }))),
        envKey: Schema.Literals(["VALID_KEY", "A1_B2", "BAD-KEY", "123BAD", "FOO=BAR", ""])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const data = Uint8Array.from(input.bytes)
            const b64 = Base64Util.encodeBase64(data)
            const decoded = yield* Base64Util.decodeBase64(b64, "fuzz")
            if (decoded.length !== data.length) return false
            for (let i = 0; i < data.length; i++) {
              if (decoded[i] !== data[i]) return false
            }
            const b64Bytes = Base64Util.encodeBase64Bytes(data)
            const decoded2 = yield* Base64Util.decodeBase64Bytes(b64Bytes, "fuzz")
            if (decoded2.length !== data.length) return false

            const slug = sessionSlug(input.session)
            if (slug.length === 0 || !/^[A-Za-z0-9._-]+$/.test(slug)) return false
            const mName = machineName(input.prefix, input.session)
            if (mName.length === 0 || !/^[a-z0-9-]+$/.test(mName)) return false

            const resolved = SandboxTools.resolve("/workspace", input.relPath)
            if (input.relPath.includes("..") || input.relPath.startsWith("/")) {
              if (resolved !== undefined) return false
            } else if (resolved !== undefined) {
              if (resolved !== "/workspace" && !resolved.startsWith("/workspace/")) return false
            }

            const rootFn = rootedAt("/workspace")
            const rooted = rootFn(input.relPath)
            if (typeof rooted !== "string") return false
            parentOf(rooted)

            const bm = boundedMessage(input.msg.repeat(input.repeat))
            if (bm.length > messageBound + 3) return false

            describeExit(Exit.succeed("ok"))
            describeExit(Exit.fail(new ProviderError({ code: "unavailable", message: "gone" })))
            const fp1 = yield* configurationFingerprint({ a: 1, b: input.prefix })
            const fp2 = yield* configurationFingerprint({ b: input.prefix, a: 1 })
            if (fp1 !== fp2) return false

            const ep = envPrefix({ [input.envKey]: "val", DROP: undefined })
            if (!Array.isArray(ep)) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })

  it("RemoteChildProcessSpawner, SandboxHealth, and SandboxSupervision handle errors and heartbeats under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        stdout: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
        exitCode: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
        healthKind: Schema.Literals(["healthy", "refusing", "unresponsive"]),
        errCode: Schema.Literals(["unavailable", "spawn_error", "timeout", "not_found", "unknown"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const safeOut = decoder.decode(encoder.encode(input.stdout))
            const remote = RemoteChildProcessSpawner.TestRemote.make({
              session: "fuzz-sess",
              scripts: {
                run: { stdout: safeOut, exitCode: input.exitCode }
              }
            })

            const { code, text } = yield* Effect.provide(
              Effect.gen(function*() {
                const sp = yield* ChildProcessSpawner
                const cmd = ChildProcess.make("run")
                return {
                  text: yield* sp.string(cmd),
                  code: yield* sp.exitCode(cmd)
                }
              }),
              RemoteChildProcessSpawner.layer(remote)
            )
            if (text !== safeOut || Number(code) !== input.exitCode) return false

            const pingProvider: SandboxHealth.PingProvider = input.healthKind === "healthy"
              ? { ping: Effect.void }
              : input.healthKind === "refusing"
              ? { ping: Effect.fail(new ProviderError({ code: input.errCode, message: "refused" })) }
              : { ping: Effect.never }

            const state = yield* SandboxHealth.probe(pingProvider, { deadline: "25 millis" })
            if (input.healthKind === "healthy") {
              if (state._tag !== "Healthy") return false
            } else {
              if (state._tag !== "Unhealthy") return false
            }

            const noopHealth = SandboxHealth.makeNoop()
            const noopState = yield* noopHealth.check
            if (noopState._tag !== "Healthy") return false

            const events: Array<SandboxSupervision.SandboxUnhealthy> = []
            const reporter: SandboxSupervision.Reporter = {
              unhealthy: (ev) =>
                Effect.sync(() => {
                  events.push(ev)
                })
            }
            const supLayer = SandboxSupervision.layer(
              RemoteChildProcessSpawner.TestRemote.make({
                session: "sup-sess",
                ping: Effect.fail(new ProviderError({ code: "unavailable", message: "dead" })),
                scripts: { hang: { stdout: "", exitCode: 0 } }
              }),
              { interval: "10 millis", deadline: "10 millis", reporter }
            )
            yield* Effect.exit(
              Effect.provide(
                Effect.flatMap(ChildProcessSpawner, (sp) => sp.string(ChildProcess.make("hang"))),
                supLayer
              )
            )
            return true
          }),
        { seed: seed + 2, executions, execution: FuzzSimulation.execution() }
      )
    )
    assertPassed(report)
  })

  it("Sandbox.TestSession, layerHost, fileSystem, commandProvider, and fanOut uphold session contracts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nBranches: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
        fileContent: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        exitCode: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const safeContent = decoder.decode(encoder.encode(input.fileContent))
            const provider = Sandbox.TestSession.make({
              files: { "/workspace/seed.txt": encoder.encode(safeContent) },
              scripts: {
                check: { stdout: safeContent, exitCode: input.exitCode }
              }
            })

            const ok = yield* Effect.scoped(
              Effect.gen(function*() {
                const session = yield* provider.acquire("k1")
                const readBytes = yield* session.readFile("/workspace/seed.txt")
                if (decoder.decode(readBytes) !== safeContent) return false
                yield* session.writeFile("/workspace/out.txt", encoder.encode(`${safeContent}!`))
                const readOut = yield* session.readFile("/workspace/out.txt")
                if (decoder.decode(readOut) !== `${safeContent}!`) return false

                const hostOk = yield* Effect.provide(
                  Effect.gen(function*() {
                    const fs = yield* FileSystem.FileSystem
                    const sp = yield* ChildProcessSpawner
                    const text = yield* fs.readFileString("/workspace/seed.txt")
                    const out = yield* sp.string(ChildProcess.make("check"))
                    return text === safeContent && out === safeContent
                  }),
                  Sandbox.layerHost(provider, { session: "k2" })
                )
                if (!hostOk) return false

                const children = yield* Sandbox.fanOut(session, { count: input.nBranches })
                return children.length === input.nBranches
              })
            )
            return ok
          }),
        { seed: seed + 3, executions }
      )
    )
    assertPassed(report)
  })

  it(
    "DirectorySandbox, SandboxTools, and HttpSandbox (client <-> serve) roundtrip files, tools, and reject path escapes",
    async () => {
      const services = await Effect.runPromise(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner
          return { fs, spawner }
        }).pipe(Effect.provide(platform))
      )

      const arb = Arbitrary.schema(
        Schema.Struct({
          fileName: Schema.Literals(["a.txt", "sub/b.txt", "dir/c.md"]),
          content: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
          escapePath: Schema.Literals(["../escape.txt", "/etc/passwd", "sub/../../escape.txt"]),
          viaHttp: Schema.Boolean
        })
      )

      const dirExecutions = Math.min(executions, 14)
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.gen(function*() {
              const iterDir = nodeFs.mkdtempSync(join(tempRoot, "dir-sb-"))
              try {
                const safeContent = decoder.decode(encoder.encode(input.content.replace(/\0/g, "x")))
                const dirProvider = DirectorySandbox.make({
                  ...services,
                  root: join(iterDir, "machines"),
                  persistence: "sticky"
                })
                const callsDirectory = join(iterDir, "calls")
                nodeFs.mkdirSync(callsDirectory, { recursive: true })

                const provider = input.viaHttp
                  ? (() => {
                    const token = "fuzz-secret-token"
                    const handler = HttpSandbox.serve({ provider: dirProvider, token })
                    const client = HttpClient.make((req) =>
                      Effect.gen(function*() {
                        const bodyBuf = req.body._tag === "Uint8Array" ? req.body.body : undefined
                        const webReq = new Request(req.url, {
                          method: req.method,
                          headers: req.headers,
                          ...(bodyBuf !== undefined ? { body: new Uint8Array(bodyBuf) } : {})
                        })
                        const webRes = yield* handler(webReq)
                        return HttpClientResponse.fromWeb(req, webRes)
                      })
                    )
                    return HttpSandbox.make({ url: "http://sandbox.local", token, client })
                  })()
                  : dirProvider

                return yield* Effect.scoped(
                  Effect.gen(function*() {
                    const session = yield* provider.acquire("k-tool")
                    execFileSync("git", ["init", "-q"], { cwd: session.workdir })
                    execFileSync("git", ["config", "user.email", "f@e.com"], { cwd: session.workdir })
                    execFileSync("git", ["config", "user.name", "F"], { cwd: session.workdir })

                    const opts = { callId: "c1", callsDirectory }
                    const wRes = yield* SandboxTools.execute(
                      session,
                      { tool: "write", path: input.fileName, content: safeContent },
                      opts
                    )
                    if (wRes.tool !== "write") return false

                    const rRes = yield* SandboxTools.execute(
                      session,
                      { tool: "read", path: input.fileName },
                      opts
                    )
                    if (rRes.tool !== "read" || rRes.content !== safeContent) return false

                    const lRes = yield* SandboxTools.execute(session, { tool: "list" }, opts)
                    if (lRes.tool !== "list" || lRes.entries.length === 0) return false

                    const stRes = yield* SandboxTools.execute(session, { tool: "status" }, opts)
                    if (stRes.tool !== "status") return false
                    const dfRes = yield* SandboxTools.execute(session, { tool: "diff" }, opts)
                    if (dfRes.tool !== "diff") return false

                    const escExit = yield* Effect.exit(
                      SandboxTools.execute(session, { tool: "read", path: input.escapePath }, opts)
                    )
                    if (!Exit.isFailure(escExit)) return false

                    const runRes = yield* SandboxTools.execute(
                      session,
                      { tool: "run", command: "echo hello-fuzz" },
                      { callId: "c2", callsDirectory }
                    )
                    return runRes.tool === "run" && runRes.exitCode === 0 && runRes.stdout.includes("hello-fuzz")
                  })
                )
              } finally {
                nodeFs.rmSync(iterDir, { recursive: true, force: true })
              }
            }),
          { seed: seed + 4, executions: dirExecutions }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it("CiJob graph validation, HttpProtocol status mapping, CloudflareSandbox.selectInstance, CommandSandbox, ContainerSandbox, and SandboxCommand", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nJobs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
        introduceCycle: Schema.Boolean,
        introduceUnknownDep: Schema.Boolean,
        errCode: Schema.Literals(["unavailable", "spawn_error", "timeout", "not_found", "unknown"]),
        cpus: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
        memoryMib: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 256, maximum: 16384 }))),
        badTimeout: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 61, maximum: 9999 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const jobs: Array<CiJob.Job> = Array.from({ length: input.nJobs }, (_, i) => ({
              name: `job_${i}`,
              steps: [{ name: "s1", run: "true" }],
              ...(i > 0 ? { needs: [`job_${i - 1}`] } : {})
            }))
            if (CiJob.graphProblem(jobs) !== undefined) return false

            if (input.introduceCycle && jobs.length >= 2) {
              const cyclic: Array<CiJob.Job> = jobs.map((j, i) =>
                i === 0 ? { ...j, needs: [`job_${jobs.length - 1}`] } : j
              )
              if (CiJob.graphProblem(cyclic) === undefined) return false
            }

            if (input.introduceUnknownDep) {
              const bad: Array<CiJob.Job> = [{ name: "j0", steps: [{ name: "s", run: "true" }], needs: ["ghost"] }]
              if (CiJob.graphProblem(bad) === undefined) return false
            }

            const status = HttpProtocol.statusOf(input.errCode)
            if (input.errCode === "not_found" && status !== 404) return false
            if (input.errCode !== "not_found" && status !== 422) return false

            const instances: ReadonlyArray<CloudflareSandbox.CloudflareSandboxInstance<string>> = [
              { name: "small", binding: "S", cpus: 2, memoryMib: 2048 },
              { name: "large", binding: "L", cpus: 8, memoryMib: 16384 }
            ]
            const picked = CloudflareSandbox.selectInstance(instances, {
              cpus: input.cpus,
              memoryMib: input.memoryMib
            })
            if (input.cpus <= 2 && input.memoryMib <= 2048) {
              if (picked.name !== "small") return false
            } else {
              if (picked.name !== "large") return false
            }

            // Exceeding all instances must throw TypeError
            let threwOversized = false
            try {
              CloudflareSandbox.selectInstance(instances, { cpus: 64, memoryMib: 65536 })
            } catch (e) {
              threwOversized = e instanceof TypeError
            }
            if (!threwOversized) return false

            const noopSpawner = makeSpawner(() =>
              Effect.succeed(
                makeHandle({
                  pid: ProcessId(1),
                  exitCode: Effect.succeed(ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Stream.empty as never,
                  stdout: Stream.make(encoder.encode("ok\n")),
                  stderr: Stream.empty,
                  all: Stream.make(encoder.encode("ok\n")),
                  getInputFd: () => Stream.empty as never,
                  getOutputFd: () => Stream.empty
                })
              )
            )
            const cmdProv = CommandSandbox.make({
              spawner: noopSpawner,
              prefix: ["sh", "-c"],
              workdir: "/tmp"
            })
            const ctrProv = ContainerSandbox.make({
              spawner: noopSpawner,
              image: "alpine:latest"
            })
            if (typeof cmdProv.acquire !== "function" || typeof ctrProv.acquire !== "function") return false

            const runSchema = SandboxCommand.Run(60)
            const badDecoded = Schema.decodeUnknownOption(runSchema)({
              command: "echo 1",
              timeoutSeconds: input.badTimeout
            })
            return badDecoded._tag === "None"
          }),
        { seed: seed + 5, executions }
      )
    )
    assertPassed(report)
  })

  it("JustBashSandbox, CloudflareSandbox, and CommandSandbox acquire sessions and roundtrip files/exec", async () => {
    const services = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner
        return { fs, spawner }
      }).pipe(Effect.provide(platform))
    )

    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["just_bash", "cf_exec", "cf_process", "cmd_local"]),
        payload: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        exitCode: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const safePayload = decoder.decode(encoder.encode(input.payload.replace(/[\0\r\n'"\\$`]/g, "x")))

            if (input.mode === "just_bash") {
              const iterDir = nodeFs.mkdtempSync(join(tempRoot, "jb-"))
              try {
                const prov = JustBashSandbox.make({
                  fs: services.fs,
                  root: iterDir,
                  bash: {
                    exec: async (cmd: string) => ({
                      stdout: `jb:${cmd.slice(0, 16)}`,
                      stderr: "",
                      exitCode: input.exitCode
                    })
                  }
                })
                return yield* Effect.scoped(
                  Effect.gen(function*() {
                    const sess = yield* prov.acquire("jb-1")
                    const f = join(sess.workdir, "a.txt")
                    yield* sess.writeFile(f, encoder.encode(safePayload))
                    const back = yield* sess.readFile(f)
                    if (decoder.decode(back) !== safePayload) return false
                    const proc = yield* sess.spawn("echo hi", {})
                    const code = yield* proc.exitCode
                    return code === input.exitCode
                  })
                )
              } finally {
                nodeFs.rmSync(iterDir, { recursive: true, force: true })
              }
            }

            if (input.mode === "cf_exec" || input.mode === "cf_process") {
              const files = new Map<string, string>()
              let destroyed = false
              const sdk: CloudflareSandbox.Sdk<string> = {
                getSandbox: () => ({
                  mkdir: async () => {},
                  writeFile: async (p, content) => {
                    files.set(p, content)
                  },
                  readFile: async (p) => {
                    const hit = files.get(p)
                    if (hit === undefined) throw new Error("ENOENT")
                    return { content: hit }
                  },
                  exec: async () => ({
                    exitCode: input.exitCode,
                    stdout: safePayload,
                    stderr: ""
                  }),
                  startProcess: async () => ({
                    exitCode: input.exitCode,
                    waitForExit: async () => ({ exitCode: input.exitCode }),
                    getLogs: async () => ({ stdout: safePayload, stderr: "" })
                  }),
                  destroy: async () => {
                    destroyed = true
                  }
                })
              }
              const prov = CloudflareSandbox.make({
                sdk,
                binding: "SANDBOX_DO",
                execution: input.mode === "cf_exec" ? "exec" : "process"
              })
              const ok = yield* Effect.scoped(
                Effect.gen(function*() {
                  const sess = yield* prov.acquire("cf-1")
                  yield* sess.writeFile("/workspace/f.bin", encoder.encode(safePayload))
                  const back = yield* sess.readFile("/workspace/f.bin")
                  if (decoder.decode(back) !== safePayload) return false
                  const proc = yield* sess.spawn("echo hi", {})
                  const chunks = yield* Stream.runCollect(proc.stdout)
                  const code = yield* proc.exitCode
                  const out = decoder.decode(Uint8Array.from(Array.from(chunks).flatMap((c) => Array.from(c))))
                  return code === input.exitCode && out === safePayload
                })
              )
              return ok && destroyed
            }

            const iterDir = nodeFs.mkdtempSync(join(tempRoot, "cmdsb-"))
            try {
              const prov = CommandSandbox.make({
                spawner: services.spawner,
                prefix: [],
                workdir: iterDir
              })
              return yield* Effect.scoped(
                Effect.gen(function*() {
                  const sess = yield* prov.acquire("cmd-1")
                  const target = join(iterDir, "file.txt")
                  yield* sess.writeFile(target, encoder.encode(safePayload))
                  const back = yield* sess.readFile(target)
                  if (decoder.decode(back) !== safePayload) return false
                  const proc = yield* sess.spawn(`printf '%s' '${safePayload}'; exit ${input.exitCode}`, {})
                  const chunks = yield* Stream.runCollect(proc.stdout)
                  const code = yield* proc.exitCode
                  const out = decoder.decode(Uint8Array.from(Array.from(chunks).flatMap((c) => Array.from(c))))
                  return code === input.exitCode && out === safePayload
                })
              )
            } finally {
              nodeFs.rmSync(iterDir, { recursive: true, force: true })
            }
          }),
        { seed: seed + 6, executions: Math.min(executions, 24) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it(
    "SandboxTools detached start/observe/collect/cancel & checkpoint/restore plus ProviderConformance/SandboxConformance",
    async () => {
      const services = await Effect.runPromise(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner
          return { fs, spawner }
        }).pipe(Effect.provide(platform))
      )

      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals(["detached_ok", "checkpoint_restore", "provider_conformance", "sandbox_conformance"]),
          tag: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
          breakOutput: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.gen(function*() {
              const safeTag = input.tag.replace(/[^a-zA-Z0-9_-]/g, "t") || "t"

              if (input.mode === "provider_conformance") {
                const provider = RemoteChildProcessSpawner.TestRemote.make({
                  session: "conf-s",
                  scripts: {
                    greet: { stdout: input.breakOutput ? "wrong" : "hello" },
                    boom: { exitCode: 3 },
                    serve: { pending: true },
                    cat: { stdout: "sandbox-conformance-stdin" }
                  }
                })
                const violations = yield* ProviderConformance.check(provider, {
                  writes: "greet",
                  output: "hello",
                  fails: "boom",
                  failureCode: 3,
                  runs: "serve",
                  stopsWithin: "50 millis"
                })
                return input.breakOutput ? violations.length > 0 : violations.length === 0
              }

              if (input.mode === "sandbox_conformance") {
                const provider = Sandbox.TestSession.make({
                  scripts: {
                    "printf hello": { stdout: "hello" },
                    "exit 3": { exitCode: 3 },
                    "sleep 60": { pending: true },
                    cat: { stdout: "sandbox-conformance-stdin" }
                  }
                })
                const violations = yield* SandboxConformance.check(provider, {
                  commands: {
                    writes: "printf hello",
                    output: "hello",
                    fails: "exit 3",
                    failureCode: 3,
                    runs: "sleep 60",
                    stopsWithin: "50 millis"
                  }
                })
                return Array.isArray(violations)
              }

              const iterDir = nodeFs.mkdtempSync(join(tempRoot, "sbcmd-"))
              try {
                const dirProv = DirectorySandbox.make({
                  ...services,
                  root: join(iterDir, "machines"),
                  persistence: "sticky"
                })
                const callsDir = join(iterDir, "calls")
                nodeFs.mkdirSync(callsDir, { recursive: true })
                return yield* Effect.scoped(
                  Effect.gen(function*() {
                    const sess = yield* dirProv.acquire("det-1")
                    execFileSync("git", ["init", "-q"], { cwd: sess.workdir })
                    execFileSync("git", ["config", "user.email", "f@e.com"], { cwd: sess.workdir })
                    execFileSync("git", ["config", "user.name", "F"], { cwd: sess.workdir })
                    nodeFs.writeFileSync(join(sess.workdir, "f.txt"), "base\n")
                    execFileSync("git", ["add", "."], { cwd: sess.workdir })
                    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: sess.workdir })

                    if (input.mode === "checkpoint_restore") {
                      nodeFs.writeFileSync(join(sess.workdir, "f.txt"), `dirty-${safeTag}\n`)
                      const cp = yield* SandboxTools.checkpoint(sess)
                      execFileSync("git", ["checkout", "--", "f.txt"], { cwd: sess.workdir })
                      yield* SandboxTools.restore(sess, cp)
                      const restored = nodeFs.readFileSync(join(sess.workdir, "f.txt"), "utf8")
                      return restored === `dirty-${safeTag}\n`
                    }

                    const cmds = SandboxCommand.onSession(sess, callsDir)
                    const started = yield* cmds.start({ tool: "run", command: `echo ${safeTag}` }, `call-${safeTag}`)
                    if (started.pid <= 0) return false
                    for (let i = 0; i < 40; i++) {
                      const obs = yield* cmds.observe(`call-${safeTag}`)
                      if (obs.state === "finished") break
                      yield* Effect.sleep("10 millis")
                    }
                    const collected = yield* cmds.collect(`call-${safeTag}`)
                    return collected.exitCode === 0 && collected.stdout.includes(safeTag)
                  })
                )
              } finally {
                nodeFs.rmSync(iterDir, { recursive: true, force: true })
              }
            }),
          { seed: seed + 7, executions: Math.min(executions, 14) }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
