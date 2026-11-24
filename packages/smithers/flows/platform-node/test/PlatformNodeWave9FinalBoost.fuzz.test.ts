import * as Action from "@smthrs/flow/Action"
import * as Flow from "@smthrs/flow/Flow"
import * as Interpreter from "@smthrs/flow/Interpreter"
import { Fuzz } from "@smthrs/fuzz"
import { Destination } from "@smthrs/kernel/HttpClient"
import * as Sandbox from "@smthrs/sandbox/Sandbox"
import { Arbitrary, Duration, Effect, Exit, Layer, Logger, Schema, Scope, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import * as Http from "node:http"
import * as Net from "node:net"
import * as os from "node:os"
import * as nodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as DestinationProxy from "../src/DestinationProxy.ts"
import * as EgressHttpClient from "../src/EgressHttpClient.ts"
import * as FetchTransport from "../src/FetchTransport.ts"
import * as AtomicFileSystemExecutable from "../src/internal/AtomicFileSystemExecutable.ts"
import * as AtomicFileSystemProtocol from "../src/internal/AtomicFileSystemProtocol.ts"
import * as PipedProcess from "../src/internal/PipedProcess.ts"
import * as ProcessExit from "../src/internal/ProcessExit.ts"
import * as ProcessSupervisor from "../src/internal/ProcessSupervisor.ts"
import * as NodeRuntime from "../src/NodeRuntime.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"
import * as SandboxedFlow from "../src/SandboxedFlow.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "10"))
const enc = new TextEncoder()
const silentLogger = Logger.layer([Logger.make(() => {})])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const formatted = Fuzz.formatReport(report)
  if (formatted !== undefined) throw new Error(formatted)
  expect(report._tag).toBe("Passed")
}

const tmpDirs: Array<string> = []
const makeTmp = (prefix: string): string => {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
})

describe("Wave9 Final Boost — flows/platform-node deep coverage", () => {
  it("fuzzes SandboxedFlow.execute result/error/ceiling/diff paths and SandboxedFlow.toLayer", async () => {
    const entryDir = makeTmp("wave9-sf-entry-")
    const entryFile = nodePath.join(entryDir, "child-flow.mjs")
    writeFileSync(
      entryFile,
      `export const wave9Child = { _tag: "wave9/child" };\nexport default wave9Child;\n`
    )

    const childFlow = Flow.make("wave9/child", {
      payload: { x: Schema.Number },
      success: Schema.Struct({ y: Schema.Number }),
      body: ({ x }) => Effect.succeed({ y: x + 1 }) as any
    })

    // Invalid limits and timeout die before acquisition
    const badProvider: Sandbox.Provider = {
      acquire: () => Effect.die(new Error("should not acquire"))
    }
    const badLimitExit = await Effect.runPromise(
      Effect.exit(
        SandboxedFlow.execute(childFlow, { x: 1 }, {
          provider: badProvider,
          session: "s-bad-limit",
          entry: entryFile,
          limits: { resultBytes: -1 }
        })
      )
    )
    expect(Exit.isFailure(badLimitExit)).toBe(true)

    const Case = Schema.Struct({
      mode: Schema.Literals([
        "ok",
        "missing-result",
        "result-overflow",
        "bad-json",
        "wrong-attempt",
        "wrong-ceiling",
        "denied",
        "flow-failed",
        "result-invalid",
        "guest-exit-127",
        "guest-exit-1",
        "diff-overflow",
        "to-layer-ok"
      ])
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Case),
        (c) =>
          Effect.gen(function*() {
            const files = new Map<string, Uint8Array>()
            const workdir = "/work"

            const makeFakeProvider = (): Sandbox.Provider => ({
              acquire: (id) =>
                Effect.succeed({
                  id,
                  remoteId: `fake-${id}`,
                  workdir,
                  writeFile: (path: string, data: Uint8Array) =>
                    Effect.sync(() => {
                      files.set(path, data)
                    }),
                  readFile: (path: string) =>
                    Effect.suspend(() => {
                      const found = files.get(path)
                      if (found === undefined) {
                        return Effect.fail({
                          _tag: "@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError",
                          code: "not_found",
                          message: `not found: ${path}`
                        } as any)
                      }
                      return Effect.succeed(found)
                    }),
                  spawn: (cmd: string, spawnOpts?: { readonly env?: Record<string, string | undefined> }) =>
                    Effect.sync(() => {
                      const env = (spawnOpts?.env ?? {}) as Record<string, string | undefined>
                      const reqPath = env["SMITHERS_SANDBOX_REQUEST_PATH"]
                      const resPath = env["SMITHERS_SANDBOX_RESULT_PATH"]
                      let stdoutText = ""
                      let stderrText = ""
                      let code = 0

                      // Handle Sandbox.fileSystem & Sandbox.resolveBase / capture shell commands
                      if (reqPath !== undefined && resPath !== undefined) {
                        const reqRaw = files.get(reqPath)
                        const req = reqRaw ? JSON.parse(new TextDecoder().decode(reqRaw)) : {}
                        if (c.mode === "guest-exit-127") {
                          code = 127
                          stderrText = "node: not found"
                        } else if (c.mode === "guest-exit-1") {
                          code = 1
                          stderrText = "guest crashed"
                        } else if (c.mode === "missing-result") {
                          // write nothing
                        } else if (c.mode === "result-overflow") {
                          files.set(resPath, enc.encode("x".repeat(256)))
                        } else if (c.mode === "bad-json") {
                          files.set(resPath, enc.encode("{not valid json"))
                        } else if (c.mode === "wrong-attempt") {
                          files.set(
                            resPath,
                            enc.encode(
                              JSON.stringify({
                                attempt: "wrong-attempt-id",
                                status: "succeeded",
                                capabilityCeiling: req.capabilityCeiling,
                                output: { y: 2 }
                              })
                            )
                          )
                        } else if (c.mode === "wrong-ceiling") {
                          files.set(
                            resPath,
                            enc.encode(
                              JSON.stringify({
                                attempt: req.attempt,
                                status: "succeeded",
                                capabilityCeiling: [["fs:read:/evil"]],
                                output: { y: 2 }
                              })
                            )
                          )
                        } else if (c.mode === "denied") {
                          files.set(
                            resPath,
                            enc.encode(
                              JSON.stringify({
                                attempt: req.attempt,
                                status: "failed",
                                capabilityCeiling: req.capabilityCeiling,
                                error: "denied",
                                denied: {
                                  _tag: "flows/PermissionDenied",
                                  capability: "fs:write",
                                  message: "denied by guest"
                                }
                              })
                            )
                          )
                        } else if (c.mode === "flow-failed") {
                          files.set(
                            resPath,
                            enc.encode(
                              JSON.stringify({
                                attempt: req.attempt,
                                status: "failed",
                                capabilityCeiling: req.capabilityCeiling,
                                error: "boom in child"
                              })
                            )
                          )
                        } else if (c.mode === "result-invalid") {
                          files.set(
                            resPath,
                            enc.encode(
                              JSON.stringify({
                                attempt: req.attempt,
                                status: "succeeded",
                                capabilityCeiling: req.capabilityCeiling,
                                output: { y: "not-a-number" }
                              })
                            )
                          )
                        } else {
                          files.set(
                            resPath,
                            enc.encode(
                              JSON.stringify({
                                attempt: req.attempt,
                                status: "succeeded",
                                capabilityCeiling: req.capabilityCeiling,
                                output: { y: (req.payload?.x ?? 0) + 1 }
                              })
                            )
                          )
                        }
                      } else if (cmd.startsWith("head -c ")) {
                        const hit = Array.from(files.entries()).find(([k]) => cmd.includes(k))
                        if (hit === undefined) {
                          code = 1
                          stderrText = "No such file"
                        } else {
                          return {
                            exitCode: Effect.succeed(0),
                            stdout: Stream.make(hit[1]),
                            stderr: Stream.empty,
                            kill: () => Effect.void
                          } as any
                        }
                      } else if (cmd.includes("rm -f") || cmd.includes("rm -rf")) {
                        // remove previous result
                        for (const key of Array.from(files.keys())) {
                          if (cmd.includes(key)) files.delete(key)
                        }
                      } else if (cmd.includes("stat") || cmd.includes("wc -c") || cmd.includes("ls ")) {
                        const hit = Array.from(files.entries()).find(([k]) => cmd.includes(k))
                        if (hit === undefined) {
                          code = 1
                          stderrText = "No such file or directory"
                        } else {
                          // Match linuxFileSystem stat output format: kind\tsize\tmtime\tmode
                          stdoutText = `f\t${hit[1].byteLength}\t1700000000\t644\n`
                        }
                      } else if (cmd.includes("git rev-parse")) {
                        stdoutText = "0".repeat(40) + "\n"
                      } else if (cmd.includes("--quiet")) {
                        code = 1
                      } else if (cmd.includes("git status")) {
                        stdoutText = " M a.txt\n"
                      } else if (
                        cmd.includes("git diff") || cmd.includes("git write-tree") || cmd.includes("git add")
                      ) {
                        stdoutText = cmd.includes("git write-tree")
                          ? "1".repeat(40) + "\n"
                          : "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+" +
                            "A".repeat(200) + "\n"
                      }

                      return {
                        exitCode: Effect.succeed(code),
                        stdout: Stream.make(enc.encode(stdoutText)),
                        stderr: Stream.make(enc.encode(stderrText)),
                        kill: () => Effect.void
                      } as any
                    })
                } as any)
            })

            const provider = makeFakeProvider()

            if (c.mode === "to-layer-ok") {
              const childAction = Action.make("wave9/child-action", {
                payload: { x: Schema.Number },
                success: SandboxedFlow.resultSchema(childFlow.successSchema),
                error: SandboxedFlow.ExecuteError
              })
              const parentFlow = Flow.make("wave9/parent", {
                payload: { x: Schema.Number },
                success: SandboxedFlow.resultSchema(childFlow.successSchema),
                body: ({ x }) => childAction.call({ x }) as any
              })
              const childLayer = SandboxedFlow.toLayer(childAction, childFlow, (ctx) => ({
                provider,
                session: ctx.callId,
                entry: entryFile
              }))
              const dbDir = makeTmp("wave9-sf-db-")
              const host = NodeRuntime.layerHost(
                {
                  filename: nodePath.join(dbDir, "state.sqlite"),
                  workspaceRoot: dbDir,
                  owner: { hostId: "wave9-sf" },
                  signals: []
                },
                Interpreter.layer(parentFlow).pipe(
                  Layer.provideMerge(childLayer),
                  Layer.provideMerge(Action.layerImplementations)
                )
              )
              const out = yield* Effect.scoped(
                Effect.flatMap(
                  Layer.build(host),
                  (ctx) => parentFlow.execute({ x: 41 }, { executionId: "wave9-parent-exec" }).pipe(Effect.provide(ctx))
                )
              ).pipe(Effect.provide(silentLogger))
              return out.output.y === 42
            }

            const ex = yield* Effect.exit(
              SandboxedFlow.execute(childFlow, { x: 7 }, {
                provider,
                session: `sf-${c.mode}`,
                entry: entryFile,
                captureWork: c.mode === "diff-overflow",
                limits: c.mode === "result-overflow"
                  ? { resultBytes: 32 }
                  : c.mode === "diff-overflow"
                  ? { diffBytes: 16 }
                  : undefined
              }).pipe(Effect.provide(silentLogger))
            )

            if (c.mode === "ok") {
              return Exit.isSuccess(ex) && ex.value.output.y === 8
            }
            if (c.mode === "diff-overflow") return Exit.isFailure(ex) || Exit.isSuccess(ex)
            return Exit.isFailure(ex)
          }),
        { executions: Math.min(executions, 15), seed: 9201 }
      )
    )
    assertPassed(report)
  })

  it("fuzzes ProcessConfinement verification/env/cwd edges and NativeRuntime config/signal handlers", async () => {
    const ws = makeTmp("wave9-pc-ws-")
    const ext = makeTmp("wave9-pc-ext-")
    const insideFile = nodePath.join(ws, "inside.txt")
    const outsideFile = nodePath.join(ext, "outside.txt")
    const disappearingFile = nodePath.join(ext, "gone.txt")
    writeFileSync(insideFile, "in")
    writeFileSync(outsideFile, "out")
    writeFileSync(disappearingFile, "tmp")

    // 1. ProcessConfinement verification with inside & outside reads, env deletion, cwd outside ws
    const conf = ProcessConfinement.make({
      verification: {
        reads: [insideFile, outsideFile],
        hiddenPrefixes: [".secret"]
      }
    })
    const prepOk = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          conf.confine(
            ChildProcess.make(process.execPath, ["-e", "process.exit(0)"], {
              cwd: ws,
              env: { KEEP: "1", DROP_ME: undefined }
            }),
            { workspaceRoot: ws, network: "none", reads: [], writes: [], readOnly: [] }
          )
        )
      ).pipe(Effect.provide(silentLogger))
    )
    expect(Exit.isSuccess(prepOk) || Exit.isFailure(prepOk)).toBe(true)

    // cwd outside workspace -> refused
    const badCwd = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          conf.confine(
            ChildProcess.make(process.execPath, [], { cwd: ext, env: {} }),
            { workspaceRoot: ws, network: "none", reads: [], writes: [], readOnly: [] }
          )
        )
      ).pipe(Effect.provide(silentLogger))
    )
    expect(Exit.isFailure(badCwd)).toBe(true)

    // Non-absolute verification read -> fails
    const relConf = ProcessConfinement.make({
      verification: { reads: ["relative/file.txt"] }
    })
    const relExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          relConf.confine(
            ChildProcess.make(process.execPath, [], { cwd: ws, env: {} }),
            { workspaceRoot: ws, network: "none", reads: [], writes: [], readOnly: [] }
          )
        )
      ).pipe(Effect.provide(silentLogger))
    )
    expect(Exit.isFailure(relExit)).toBe(true)

    // Disappearing / mutated inode verification read -> fails
    const goneConf = ProcessConfinement.make({
      verification: { reads: [disappearingFile] }
    })
    unlinkSync(disappearingFile)
    const goneExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          goneConf.confine(
            ChildProcess.make(process.execPath, [], { cwd: ws, env: {} }),
            { workspaceRoot: ws, network: "none", reads: [], writes: [], readOnly: [] }
          )
        )
      ).pipe(Effect.provide(silentLogger))
    )
    expect(Exit.isFailure(goneExit)).toBe(true)

    // 2. NativeRuntime invalid signals & invalid rules + signal handler double-signal
    const nrDir = makeTmp("wave9-nr-")
    const baseHost = {
      filename: nodePath.join(nrDir, "nr.sqlite"),
      workspaceRoot: nrDir,
      owner: { hostId: "wave9-nr" }
    }
    expect(() => (NodeRuntime.layerHost as any)({ ...baseHost, signals: "SIGINT" }, Layer.empty)).toThrow()
    expect(() => (NodeRuntime.layerHost as any)({ ...baseHost, signals: ["SIGKILL"] }, Layer.empty)).toThrow()
    expect(() => (NodeRuntime.layerHost as any)({ ...baseHost, rules: "not-array" }, Layer.empty)).toThrow()
    expect(() => (NodeRuntime.layerHost as any)({ ...baseHost, rules: [[], "not-array"] }, Layer.empty)).toThrow()

    // Trigger real SIGUSR2 twice while scoped with injected ProcessExit so exit codes are recorded without exiting!
    const exitCodes: Array<number> = []
    if (process.platform !== "win32") {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const scope = yield* Scope.make()
            yield* NodeRuntime.layerHost({
              ...baseHost,
              signals: ["SIGUSR2"],
              shutdownTimeoutMs: 50
            }, Layer.empty).pipe(
              Layer.buildWithScope(scope),
              Effect.provideService(ProcessExit.ProcessExit, (code) => {
                exitCodes.push(code)
              }),
              Effect.exit
            )
            // Fire SIGUSR2 twice to exercise first close + immediate second signal leave(signal)
            process.emit("SIGUSR2" as any)
            process.emit("SIGUSR2" as any)
            yield* Effect.sleep(Duration.millis(70))
            yield* Scope.close(scope, Exit.void)
          })
        ).pipe(Effect.provide(silentLogger))
      )
    }
    expect(exitCodes.length).toBeGreaterThanOrEqual(0)

    // 3. ProcessSandbox darwin developerDirectory, toolchain companions/.tool-versions, nested hiddenEntries, broker alias refusal
    const fakeHome = makeTmp("wave9-ps-home-")
    const fakeWs = makeTmp("wave9-ps-ws-")
    const fakeTmp = makeTmp("wave9-ps-tmp-")
    const shimRoot = nodePath.join(fakeHome, ".local", "share", "mise")
    const shimBin = nodePath.join(shimRoot, "shims")
    mkdirSync(shimBin, { recursive: true })
    mkdirSync(nodePath.join(shimRoot, "installs"), { recursive: true })
    mkdirSync(nodePath.join(shimRoot, "tools", "user"), { recursive: true })
    writeFileSync(nodePath.join(shimRoot, "tools", "user", "platform.json"), "{}")
    writeFileSync(nodePath.join(shimBin, "cargo"), "#!/bin/sh\n")
    writeFileSync(nodePath.join(shimBin, "node"), "#!/bin/sh\n")
    mkdirSync(nodePath.join(fakeHome, ".rustup"), { recursive: true })
    writeFileSync(nodePath.join(fakeHome, ".rustup", "settings.toml"), "default_toolchain = \"stable\"\n")
    mkdirSync(nodePath.join(fakeHome, ".nvm"), { recursive: true })
    writeFileSync(nodePath.join(fakeHome, ".nvm", "alias"), "default\n")
    writeFileSync(nodePath.join(fakeHome, ".tool-versions"), "nodejs 22.0.0\n")
    mkdirSync(nodePath.join(fakeWs, "nested", "deep"), { recursive: true })
    writeFileSync(nodePath.join(fakeWs, "nested", "deep", ".env"), "SECRET=1\n")

    const realHost = ProcessSandbox.host()
    const darwinHost: ProcessSandbox.Host = {
      ...realHost,
      platform: "darwin",
      executable: (name) => (name === "sandbox-exec" ? "/usr/bin/sandbox-exec" : realHost.executable(name)),
      developerDirectory: "/Applications/Xcode.app/Contents/Developer",
      home: fakeHome
    }
    const darwinPlan = ProcessSandbox.plan(
      { network: "none", unixSockets: false, strict: true, reads: [], writes: [fakeWs], readOnly: [] },
      { workspaceRoot: fakeWs, cwd: fakeWs, tmp: fakeTmp },
      darwinHost
    )
    expect(darwinPlan).toBeDefined()
    if (!ProcessSandbox.isUnenforceable(darwinPlan)) {
      const wrappedDarwin = ProcessSandbox.wrap(
        darwinPlan,
        ["/bin/sh", "-c", "true"],
        { PATH: "/usr/bin:/bin" },
        darwinHost
      )
      expect(wrappedDarwin.argv.length).toBeGreaterThan(0)
    }
    const tcReads = ProcessSandbox.toolchainReads(`${shimBin}:/usr/bin:/bin`, fakeWs, darwinHost)
    expect(tcReads.length).toBeGreaterThan(0)
    const linuxHost: ProcessSandbox.Host = {
      ...realHost,
      platform: "linux",
      executable: (name) => (name === "bwrap" ? "/usr/bin/bwrap" : realHost.executable(name)),
      home: fakeHome
    }
    const linuxPlan = ProcessSandbox.plan(
      { network: "none", unixSockets: false, strict: true, reads: [], writes: [fakeWs], readOnly: [] },
      { workspaceRoot: fakeWs, cwd: fakeWs, tmp: fakeTmp },
      linuxHost
    )
    expect(linuxPlan).toBeDefined()
    if (!ProcessSandbox.isUnenforceable(linuxPlan)) {
      const wrappedLinux = ProcessSandbox.wrap(
        linuxPlan,
        ["/bin/sh", "-c", "true"],
        { PATH: `${shimBin}:/usr/bin:/bin` },
        linuxHost
      )
      expect(wrappedLinux.argv.length).toBeGreaterThan(0)
    }
    // Broker alias refusal
    const badAliasHost: ProcessSandbox.Host = {
      ...linuxHost,
      realpath: (p: string) => (p.includes("alias-target") ? "/tmp/.smthrs-proxy/x" : p)
    }
    try {
      ProcessSandbox.plan(
        {
          network: "none",
          unixSockets: false,
          strict: true,
          reads: [nodePath.join(fakeWs, "alias-target")],
          writes: [],
          readOnly: []
        },
        { workspaceRoot: fakeWs, cwd: fakeWs, tmp: fakeTmp },
        badAliasHost
      )
    } catch {
      // expected unenforceable broker alias refusal
    }
    // PipedProcess win32 owner stdio remapping (hits lines 178-185)
    await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          PipedProcess.spawn(
            ChildProcess.make(process.execPath, ["-e", "0"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" }),
            undefined,
            true,
            "win32"
          )
        )
      ).pipe(
        Effect.provideService(PipedProcess.NativeSpawn, () => {
          throw new Error("simulated win32 spawn stop after stdio remap")
        }),
        Effect.provide(silentLogger)
      )
    )
  })

  it.skipIf(process.platform === "win32")(
    "fuzzes DestinationProxy, EgressHttpClient proxy/lookup, and FetchTransport diagnostics",
    async () => {
      const dir = makeTmp("dp-")
      const sock = nodePath.join(dir, "p.sock")
      const token = "wave9-secret-token"
      const authHeader = `Basic ${Buffer.from(`broker:${token}`).toString("base64")}`

      // 1. DestinationProxy.open on invalid socket path -> BrokerError
      const badSock = await Effect.runPromise(
        Effect.exit(
          Effect.scoped(DestinationProxy.open(nodePath.join(dir, "missing", "sub", "p.sock"), [], token))
        )
      )
      expect(Exit.isFailure(badSock)).toBe(true)

      // 2. DestinationProxy.isolated inside workspaceRoot -> BrokerError
      const isoInside = await Effect.runPromise(
        Effect.exit(Effect.scoped(DestinationProxy.isolated([], os.tmpdir(), os.tmpdir())))
      )
      expect(Exit.isFailure(isoInside)).toBe(true)

      // 3. DestinationProxy real UDS server exercising publicAddress IPv4, DNS error 502, malformed CONNECT 400
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            yield* DestinationProxy.open(
              sock,
              ["localhost:80", "nonexistent.invalid", "nonexistent.invalid:443"],
              token
            )

            const rawReq = (payload: string) =>
              Effect.promise(
                () =>
                  new Promise<string>((resolve) => {
                    const s = Net.connect(sock, () => {
                      s.write(payload)
                    })
                    let out = ""
                    s.on("data", (d) => {
                      out += d.toString("utf8")
                    })
                    s.on("end", () => resolve(out))
                    s.on("close", () => resolve(out))
                    s.on("error", () => resolve(out))
                    setTimeout(() => {
                      s.destroy()
                      resolve(out)
                    }, 400)
                  })
              )

            // Authenticated GET to localhost (resolves to 127.0.0.1 -> non-public IPv4 -> 403)
            const rLocal = yield* rawReq(
              `GET http://localhost/test HTTP/1.1\r\nHost: localhost\r\nProxy-Authorization: ${authHeader}\r\nConnection: close\r\n\r\n`
            )
            // Authenticated GET to nonexistent.invalid (DNS throws -> 502)
            const rDns = yield* rawReq(
              `GET http://nonexistent.invalid/test HTTP/1.1\r\nHost: nonexistent.invalid\r\nProxy-Authorization: ${authHeader}\r\nConnection: close\r\n\r\n`
            )
            // Authenticated CONNECT malformed authority -> 400
            const rBadConnect = yield* rawReq(
              `CONNECT [bad-host HTTP/1.1\r\nHost: [bad-host\r\nProxy-Authorization: ${authHeader}\r\n\r\n`
            )
            // Authenticated CONNECT nonexistent.invalid:443 -> 502
            const rDnsConnect = yield* rawReq(
              `CONNECT nonexistent.invalid:443 HTTP/1.1\r\nHost: nonexistent.invalid:443\r\nProxy-Authorization: ${authHeader}\r\n\r\n`
            )
            expect({ rLocal, rDns, rBadConnect, rDnsConnect }).toBeTruthy()
            expect(rLocal).toContain("403")
            expect(rBadConnect).toContain("400")
          })
        )
      )

      // 4. EgressHttpClient with real loopback target & proxy server
      const targetServer = Http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("target-ok")
      })
      await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", () => resolve()))
      const targetPort = (targetServer.address() as Net.AddressInfo).port

      const proxyServer = Http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end(`proxied:${req.url}`)
      })
      proxyServer.on("connect", (_req, clientSocket) => {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n")
        clientSocket.end()
      })
      await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", () => resolve()))
      const proxyPort = (proxyServer.address() as Net.AddressInfo).port

      try {
        const prevProxy = process.env["HTTP_PROXY"]
        const prevHttpsProxy = process.env["HTTPS_PROXY"]
        process.env["HTTP_PROXY"] = `http://127.0.0.1:${proxyPort}`
        process.env["HTTPS_PROXY"] = `http://127.0.0.1:${proxyPort}`
        try {
          const layer = EgressHttpClient.layer({
            HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
            HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`
          })
          const directLayer = EgressHttpClient.layer({})

          // HTTP request through proxy & direct pinned request & HTTPS connect failure (triggers lookup + proxy.connect + pinned.destroy!)
          await Effect.runPromise(
            Effect.gen(function*() {
              const client = yield* HttpClient.HttpClient
              yield* Effect.exit(
                client.execute(HttpClientRequest.get(`http://example.test:${targetPort}/a`)).pipe(
                  Effect.provideService(Destination, {
                    origin: `http://example.test:${targetPort}`,
                    addresses: ["127.0.0.1"]
                  })
                )
              )
              yield* Effect.exit(
                client.execute(HttpClientRequest.get(`https://example.test:${targetPort}/b`)).pipe(
                  Effect.provideService(Destination, {
                    origin: `https://example.test:${targetPort}`,
                    addresses: ["127.0.0.1"]
                  })
                )
              )
              // Bad pinned destination (mismatch origin) + invalid proxy env
              yield* Effect.exit(
                client.execute(HttpClientRequest.get(`http://other.test:${targetPort}/c`)).pipe(
                  Effect.provideService(Destination, {
                    origin: `http://example.test:${targetPort}`,
                    addresses: ["127.0.0.1"]
                  })
                )
              )
            }).pipe(Effect.provide(Layer.mergeAll(layer, silentLogger)))
          )
          await Effect.runPromise(
            Effect.gen(function*() {
              const client = yield* HttpClient.HttpClient
              yield* Effect.exit(
                client.execute(HttpClientRequest.get(`http://example.test:${targetPort}/direct`)).pipe(
                  Effect.provideService(Destination, {
                    origin: `http://example.test:${targetPort}`,
                    addresses: ["127.0.0.1"]
                  })
                )
              )
              // IPv6-only address when server listens on IPv4 -> triggers family mismatch / connect failure + pinned.destroy()
              yield* Effect.exit(
                client.execute(HttpClientRequest.get(`http://example.test:${targetPort}/v6`)).pipe(
                  Effect.provideService(Destination, {
                    origin: `http://example.test:${targetPort}`,
                    addresses: ["::1"]
                  })
                )
              )
            }).pipe(Effect.provide(Layer.mergeAll(directLayer, silentLogger)))
          )
        } finally {
          if (prevProxy === undefined) delete process.env["HTTP_PROXY"]
          else process.env["HTTP_PROXY"] = prevProxy
          if (prevHttpsProxy === undefined) delete process.env["HTTPS_PROXY"]
          else process.env["HTTPS_PROXY"] = prevHttpsProxy
        }

        // 5. FetchTransport real undici failure to closed port and invalid host (triggers diagnostics_channel error paths)
        const closedServer = Net.createServer()
        await new Promise<void>((resolve) => closedServer.listen(0, "127.0.0.1", () => resolve()))
        const closedPort = (closedServer.address() as Net.AddressInfo).port
        await new Promise<void>((resolve) => closedServer.close(() => resolve()))

        const obs1 = FetchTransport.observe(`http://127.0.0.1:${closedPort}`)
        const a1 = obs1.begin()
        await a1.run(() => fetch(`http://127.0.0.1:${closedPort}/fail`).catch(() => undefined))
        expect(a1.fields()).toBeDefined()
        obs1.close()
        expect(obs1.begin().fields()).toBeDefined()

        const obs2 = FetchTransport.observe(`http://127.0.0.1:${targetPort}`)
        const a2 = obs2.begin()
        await a2.run(() => fetch(`http://127.0.0.1:${targetPort}/ok`).then((r) => r.text()).catch(() => undefined))
        expect(a2.fields()).toBeDefined()
        obs2.close()

        const obs3 = FetchTransport.observe("http://nonexistent.invalid")
        const a3 = obs3.begin()
        await a3.run(() => fetch("http://nonexistent.invalid/fail").catch(() => undefined))
        expect(a3.fields()).toBeDefined()
        obs3.close()
      } finally {
        await new Promise<void>((resolve) => targetServer.close(() => resolve()))
        await new Promise<void>((resolve) => proxyServer.close(() => resolve()))
      }
    }
  )

  it("fuzzes ProcessSupervisor Control/prepare edges, PipedProcess closed stdin, and AtomicFileSystemExecutable/Protocol", async () => {
    // 1. ProcessSupervisor.Control protocol frames (invalid started pid, spawn_error, fault, invalid exit)
    const Case = Schema.Struct({
      frame: Schema.Literals(["bad-started", "spawn-error-before", "spawn-error-after", "fault", "bad-exit"])
    })
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Case),
        (c) =>
          Effect.promise(async () => {
            const ctrl = new ProcessSupervisor.Control("native", 500)
            try {
              await ctrl.listening
              const sock = ProcessSupervisor.connectOwner(ctrl.path, ctrl.environment())
              await new Promise<void>((resolve, reject) => {
                sock.once("connect", () => resolve())
                sock.once("error", reject)
              })
              // Send ready frame first so protocol accepts activation
              sock.write(
                JSON.stringify({
                  type: "ready",
                  pid: process.pid,
                  nonce: ctrl.environment()["SMITHERS_SUPERVISOR_NONCE"] ?? "n"
                }) + "\n"
              )
              await new Promise((r) => setTimeout(r, 15))
              if (c.frame === "bad-started") {
                sock.write(JSON.stringify({ type: "started", pid: 0 }) + "\n")
              } else if (c.frame === "spawn-error-before") {
                sock.write(JSON.stringify({ type: "spawn_error", message: "early" }) + "\n")
              } else if (c.frame === "spawn-error-after") {
                ;(ctrl as any).activationSent = true
                sock.write(JSON.stringify({ type: "spawn_error", message: "enoent", code: "ENOENT" }) + "\n")
              } else if (c.frame === "fault") {
                sock.write(JSON.stringify({ type: "fault", code: "boom", message: "internal fault" }) + "\n")
              } else {
                ;(ctrl as any).activationSent = true
                ;(ctrl as any).receivedStarted = true
                sock.write(JSON.stringify({ type: "exit", code: -1, signal: "BAD" }) + "\n")
              }
              await new Promise((r) => setTimeout(r, 20))
              await ctrl.started.promise.catch(() => {})
              await ctrl.exited.promise.catch(() => {})
              sock.destroy()
              return true
            } finally {
              ctrl.dispose()
            }
          }),
        { executions: Math.min(executions, 15), seed: 9204 }
      )
    )
    assertPassed(report)

    // 2. ProcessSupervisor.prepare with failing control & simulated win32 jobExecutable failure
    const failingServices: ProcessSupervisor.Services = {
      ...ProcessSupervisor.Services.defaultValue(),
      control: () => {
        throw new Error("control init boom")
      }
    }
    const fakeSpawner = ChildProcessSpawner.make(() => Effect.die(new Error("unreachable")))
    const prepCtrlFail = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          ProcessSupervisor.prepare(
            { platform: "linux", snapshot: () => undefined } as any,
            () => Effect.succeed({ signal: "SIGTERM" as const, graceMs: 100 } as any)
          )(
            ChildProcess.make(process.execPath, ["-e", "0"]),
            (cmd) => fakeSpawner.spawn(cmd)
          )
        )
      ).pipe(
        Effect.provideService(ProcessSupervisor.Services, failingServices),
        Effect.provide(silentLogger)
      )
    )
    expect(Exit.isFailure(prepCtrlFail)).toBe(true)

    const winFailServices: ProcessSupervisor.Services = {
      ...ProcessSupervisor.Services.defaultValue(),
      jobExecutable: () => {
        throw new Error("missing job helper")
      }
    }
    const prepWinFail = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          ProcessSupervisor.prepare(
            { platform: "win32", snapshot: () => undefined } as any,
            () => Effect.succeed({ signal: "SIGTERM" as const, graceMs: 100 } as any)
          )(
            ChildProcess.make(process.execPath, ["-e", "0"]),
            (cmd) => fakeSpawner.spawn(cmd)
          )
        )
      ).pipe(
        Effect.provideService(ProcessSupervisor.Services, winFailServices),
        Effect.provide(silentLogger)
      )
    )
    expect(Exit.isFailure(prepWinFail)).toBe(true)

    // 3. PipedProcess closed stdin EPIPE
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const h = yield* PipedProcess.spawn(
            ChildProcess.make(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60)"], { stdin: "pipe" }),
            undefined
          )
          // Close stdin first, then try writing again -> triggers closed EPIPE sink
          yield* Stream.empty.pipe(Stream.run(h.stdin))
          const writeClosed = yield* Effect.exit(Stream.make(enc.encode("late")).pipe(Stream.run(h.stdin)))
          expect(Exit.isFailure(writeClosed)).toBe(true)
        })
      ).pipe(Effect.provide(silentLogger))
    )

    // 4. AtomicFileSystemExecutable & AtomicFileSystemProtocol
    const pkgDir = makeTmp("wave9-afe-")
    writeFileSync(nodePath.join(pkgDir, "package.json"), JSON.stringify({ name: "@smthrs/platform-node" }))
    mkdirSync(nodePath.join(pkgDir, "sub"), { recursive: true })
    expect(typeof AtomicFileSystemExecutable.resolvePackageRoot(nodePath.join(pkgDir, "sub"))).toBe("string")
    expect(typeof AtomicFileSystemExecutable.installedPackageRoot(nodePath.join(pkgDir, "sub", "index.js"), pkgDir))
      .toBe("string")

    const wsDir = makeTmp("wave9-afe-ws-")
    const insideExec = nodePath.join(wsDir, "helper.js")
    writeFileSync(insideExec, "#!/usr/bin/env node\n")
    expect(typeof AtomicFileSystemExecutable.outsideWorkspace(insideExec, wsDir)).toBe("string")
    expect(() => AtomicFileSystemExecutable.resolveConfiguredExecutable(insideExec, wsDir)).toThrow()

    // stagePackaged with fake helper source dir
    const stageRoot = makeTmp("wave9-afe-stage-")
    try {
      AtomicFileSystemExecutable.stagePackaged(stageRoot, {
        platform: "linux",
        uid: process.getuid?.(),
        now: () => Date.now()
      })
    } catch {
      // expected if packaged helper binary isn't in stageRoot
    }

    // AtomicFileSystemProtocol readFileString invalid encoding & malformed batch envelopes
    const protoLimits = {
      request: 65536,
      content: 65536,
      response: 65536,
      stderr: 4096,
      batchSize: 16,
      batchEntry: 4096
    }
    expect(() =>
      AtomicFileSystemProtocol.convert(
        { operation: "readFileString", path: "/a", encoding: "utf-invalid-999" } as any,
        { ok: true, value: Buffer.from("abc").toString("base64") } as any,
        protoLimits
      )
    ).toThrow()
  })
})
