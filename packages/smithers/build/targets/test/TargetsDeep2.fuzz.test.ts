import { Fuzz } from "@smthrs/fuzz"
import type * as ProcessSandbox from "@smthrs/platform-node/ProcessSandbox"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import { spawn, spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import * as Config from "../src/Config.ts"
import * as DepsLint from "../src/DepsLint.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as Input from "../src/Input.ts"
import * as Install from "../src/Install.ts"
import * as ExecStage from "../src/internal/ExecStage.ts"
import { PublicationFileSystem } from "../src/internal/PublicationFileSystem.ts"
import * as SecretProxyTunnel from "../src/internal/SecretProxyTunnel.ts"
import * as JobKeeper from "../src/JobKeeper.ts"
import * as PackageDefaults from "../src/PackageDefaults.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Reference from "../src/Reference.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Secret from "../src/Secret.ts"
import * as SecretProxy from "../src/SecretProxy.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"
import { plannedCalls } from "./plan.ts"
import { packageManager, runtime } from "./toolchain.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const fsExecutions = Math.min(executions, 20)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/targets deep fuzz suite 2: Compose, ExecStage, SecretProxyTunnel, PackageDefaults, Config, DepsLint, Install & JobKeeper", () => {
  it("Compose declarations, Files algebra, checkGenerator backup/rollback/limits & GenerateCheckLive", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-compose-")))
    try {
      const cmd = Shell.Test({ shell: "true" })
      const leftFg = Filegroup.Filegroup({ cwd: "pkg", srcs: [Input.glob("src/**/*.ts")] })
      const rightFg = Filegroup.Filegroup({ cwd: "pkg", srcs: [Input.glob("src/**/*.test.ts")] })

      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "success-no-drift",
            "fail-drift-modify",
            "fail-drift-create-nested",
            "fail-restore-file",
            "fail-replace-dir-with-file",
            "fail-replace-dir-with-symlink",
            "fail-delete-file",
            "escape-change",
            "limit-files",
            "io-mkdtemp-fail",
            "io-rename-fail"
          ]),
          genKind: Schema.Literals(["bin", "command", "emit", "script", "none", "multiple"]),
          checkKind: Schema.Literals(["fg-diff", "closure-diff", "left-bad", "right-bad", "digest", "manifest"]),
          content: Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,20}$/))
        })
      )

      let runIdx = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode, genKind, checkKind, content }) =>
            Effect.gen(function*() {
              // 1. Compose.Generate forms & refusals
              if (genKind === "bin") {
                const calls = plannedCalls(
                  Compose.Generate({ bin: Reference.NodeModule.Bin("fmt", "fmt"), args: ["--check"], changes: ["a.txt"] })
                )
                if (calls[0]?.action !== "smithers-build/exec") throw new Error("bin exec")
              } else if (genKind === "command") {
                const calls = plannedCalls(Compose.Generate({ command: "true", changes: ["a.txt"] }))
                if (calls[0]?.action !== "smithers-build/exec") throw new Error("command exec")
              } else if (genKind === "emit") {
                const calls = plannedCalls(Compose.Generate({ emit: { "a.txt": content } }))
                if (calls[0]?.action !== "smithers-build/not-implemented") throw new Error("emit")
              } else if (genKind === "script") {
                const calls = plannedCalls(Compose.Generate({ script: { path: "gen.ts" }, changes: ["a.txt"] }))
                if (calls.length === 0) throw new Error("script")
              } else if (genKind === "none") {
                let threw = false
                try {
                  Compose.Generate({ changes: ["a.txt"] })
                } catch {
                  threw = true
                }
                if (!threw) throw new Error("expected none throw")
              } else {
                let threw = false
                try {
                  Compose.Generate({ command: "true", script: { path: "gen.ts" }, changes: ["a.txt"] })
                } catch {
                  threw = true
                }
                if (!threw) throw new Error("expected multiple throw")
              }

              // 2. Compose.Files & Compose.Test checks
              const closure = Compose.ImportClosure({ entries: leftFg })
              if (!Compose.isImportClosure(closure)) throw new Error("closure")
              if (Compose.isImportClosure(cmd)) throw new Error("not closure")
              if (checkKind === "fg-diff") {
                const t = Compose.Test({ expect: Compose.Files.difference(leftFg, rightFg), toBe: "empty" })
                if (plannedCalls(t)[0]?.action !== "smithers-build/files-difference") throw new Error("fg-diff")
              } else if (checkKind === "closure-diff") {
                const op1 = Compose.checkOperand(closure)
                const op2 = Compose.checkOperand(closure.files)
                if (typeof op1 === "string" || typeof op2 === "string") throw new Error("closure operand")
                const t = Compose.Test({ expect: Compose.Files.difference(closure, closure.files), toBe: "empty" })
                if (plannedCalls(t)[0]?.action !== "smithers-build/files-difference") throw new Error("closure-diff")
              } else if (checkKind === "left-bad") {
                const t = Compose.Test({ expect: Compose.Files.difference(cmd, rightFg), toBe: "empty" })
                if (plannedCalls(t)[0]?.action !== "smithers-build/not-implemented") throw new Error("left-bad")
              } else if (checkKind === "right-bad") {
                const t = Compose.Test({ expect: Compose.Files.difference(leftFg, cmd), toBe: "empty" })
                if (plannedCalls(t)[0]?.action !== "smithers-build/not-implemented") throw new Error("right-bad")
              } else if (checkKind === "digest") {
                const t = Compose.Test({ expect: Compose.Files.digest(leftFg), toBe: "empty" })
                if (plannedCalls(t)[0]?.action !== "smithers-build/not-implemented") throw new Error("digest")
              } else {
                const t = Compose.Test({
                  expect: Compose.Files.difference(leftFg, rightFg),
                  toBe: Input.file("manifest.json")
                })
                if (plannedCalls(t)[0]?.action !== "smithers-build/not-implemented") throw new Error("manifest")
              }

              // 3. Invalid operands & wrappers
              try {
                Compose.Alias(42 as never)
                throw new Error("should throw")
              } catch (e) {
                if (!(e instanceof TypeError)) throw e
              }
              try {
                Compose.Materialize(42 as never)
                throw new Error("should throw")
              } catch (e) {
                if (!(e instanceof TypeError)) throw e
              }
              try {
                Compose.Files.difference(42 as never, cmd)
                throw new Error("should throw")
              } catch (e) {
                if (!(e instanceof TypeError)) throw e
              }
              const badIc = Compose.ImportClosure({ entries: cmd })
              if (plannedCalls(badIc)[0]?.action !== "smithers-build/not-implemented") throw new Error("badIc")

              // 4. Real Compose.checkGenerator with temp workspace
              const idx = runIdx++
              const ws = NodePath.join(tmpRoot, `ws-${idx}`)
              const outside = NodePath.join(tmpRoot, `outside-${idx}`)
              yield* Effect.promise(async () => {
                await Fs.mkdir(NodePath.join(ws, "out/sub"), { recursive: true })
                await Fs.mkdir(outside, { recursive: true })
                await Fs.writeFile(NodePath.join(ws, "out/sub/orig.txt"), `orig-${content}`, "utf8")
                await Fs.chmod(NodePath.join(ws, "out/sub/orig.txt"), 0o640)
                await Fs.writeFile(NodePath.join(outside, "sentinel.txt"), "safe", "utf8")
              })

              const runCheck = (
                script: string,
                changes: ReadonlyArray<string>,
                snapshotLimits: Record<string, number> = {},
                io: typeof Fs = Fs
              ) =>
                Compose.checkGenerator({ workspaceRoot: ws, snapshotLimits }, {
                  run: {
                    argv: [process.execPath, "-e", script],
                    cwd: ".",
                    env: {},
                    secrets: [],
                    expectedExitCodes: [0],
                    timeoutMs: 30_000
                  },
                  changes
                } as never).pipe(
                  Effect.provideService(PublicationFileSystem, io),
                  Effect.exit
                )

              if (mode === "success-no-drift") {
                const exit = yield* runCheck(
                  `const fs = require("node:fs"); fs.writeFileSync("out/sub/orig.txt", ${JSON.stringify("orig-" + content)});`,
                  ["out/sub/orig.txt"]
                )
                if (Exit.isFailure(exit)) throw new Error(`expected success: ${String(exit.cause)}`)
                const after = yield* Effect.promise(() => Fs.readFile(NodePath.join(ws, "out/sub/orig.txt"), "utf8"))
                if (after !== `orig-${content}`) throw new Error(`file changed unexpectedly: ${after}`)
              } else if (mode === "fail-drift-modify") {
                const exit = yield* runCheck(
                  `const fs = require("node:fs"); fs.writeFileSync("out/sub/orig.txt", ${JSON.stringify("new-" + content)});`,
                  ["out/sub/orig.txt"]
                )
                if (!Exit.isFailure(exit)) throw new Error("expected DriftError")
                const after = yield* Effect.promise(() => Fs.readFile(NodePath.join(ws, "out/sub/orig.txt"), "utf8"))
                if (after !== `orig-${content}`) throw new Error(`checkGenerator did not restore after drift: ${after}`)
              } else if (mode === "fail-drift-create-nested") {
                const exit = yield* runCheck(
                  `const fs = require("node:fs"); fs.mkdirSync("gen/a", { recursive: true }); fs.writeFileSync("gen/a/x.txt", ${JSON.stringify(content)});`,
                  ["gen"]
                )
                if (!Exit.isFailure(exit)) throw new Error("expected DriftError on newly created file")
                if (NodeFs.existsSync(NodePath.join(ws, "gen"))) throw new Error("checkGenerator should clean created gen dir")
              } else if (mode === "fail-restore-file") {
                const exit = yield* runCheck(
                  `const fs = require("node:fs"); fs.writeFileSync("out/sub/orig.txt", "mutated"); process.exit(1);`,
                  ["out/sub/orig.txt"]
                )
                if (!Exit.isFailure(exit)) throw new Error("expected failure")
                const restored = yield* Effect.promise(() => Fs.readFile(NodePath.join(ws, "out/sub/orig.txt"), "utf8"))
                if (restored !== `orig-${content}`) throw new Error("file not restored after failure")
              } else if (mode === "fail-replace-dir-with-file") {
                const exit = yield* runCheck(
                  `const fs = require("node:fs"); fs.rmSync("out", { recursive: true }); fs.writeFileSync("out", "file-now"); process.exit(1);`,
                  ["out", "out/sub/orig.txt"]
                )
                if (!Exit.isFailure(exit)) throw new Error("expected failure")
                const restored = yield* Effect.promise(() => Fs.readFile(NodePath.join(ws, "out/sub/orig.txt"), "utf8"))
                if (restored !== `orig-${content}`) throw new Error("dir not restored from file")
              } else if (mode === "fail-replace-dir-with-symlink") {
                const exit = yield* runCheck(
                  `const fs = require("node:fs"); fs.rmSync("out", { recursive: true }); fs.symlinkSync(${JSON.stringify(outside)}, "out"); process.exit(1);`,
                  ["out", "out/sub/orig.txt"]
                )
                if (!Exit.isFailure(exit)) throw new Error("expected failure")
                const sentinel = yield* Effect.promise(() => Fs.readFile(NodePath.join(outside, "sentinel.txt"), "utf8"))
                if (sentinel !== "safe") throw new Error("outside modified!")
              } else if (mode === "fail-delete-file") {
                const exit = yield* runCheck(
                  `const fs = require("node:fs"); fs.unlinkSync("out/sub/orig.txt"); process.exit(2);`,
                  ["out/sub/orig.txt"]
                )
                if (!Exit.isFailure(exit)) throw new Error("expected failure")
                const restored = yield* Effect.promise(() => Fs.readFile(NodePath.join(ws, "out/sub/orig.txt"), "utf8"))
                if (restored !== `orig-${content}`) throw new Error("deleted file not restored")
              } else if (mode === "escape-change") {
                const exit = yield* runCheck("process.exit(0)", ["../escape.txt"])
                if (!Exit.isFailure(exit)) throw new Error("expected escape failure")
              } else if (mode === "limit-files") {
                yield* Effect.promise(async () => {
                  await Fs.writeFile(NodePath.join(ws, "out/sub/extra1.txt"), "1", "utf8")
                  await Fs.writeFile(NodePath.join(ws, "out/sub/extra2.txt"), "2", "utf8")
                })
                const exit = yield* runCheck("process.exit(0)", ["out"], { fileBytes: 2, totalBytes: 2 })
                if (!Exit.isFailure(exit)) throw new Error("expected limit failure")
              } else if (mode === "io-mkdtemp-fail") {
                const failingIo: typeof Fs = {
                  ...Fs,
                  mkdtemp: (() => Promise.reject(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }))) as typeof Fs.mkdtemp
                }
                const exit = yield* runCheck("require('node:fs').writeFileSync('out/sub/orig.txt', 'drifted'); process.exit(1);", ["out"], {}, failingIo)
                if (!Exit.isFailure(exit)) throw new Error("expected mkdtemp failure")
              } else {
                const failingIo: typeof Fs = {
                  ...Fs,
                  rename: () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))
                }
                const exit = yield* runCheck("require('node:fs').writeFileSync('out/sub/orig.txt', 'drifted'); process.exit(1);", ["out"], {}, failingIo)
                if (!Exit.isFailure(exit)) throw new Error("expected rename failure")
              }
              return true
            }),
          { executions: fsExecutions, seed }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }, 120_000)

  it("ExecStage prepare/release/fallback-copy, SecretProxyTunnel & live SecretProxy HTTP/CONNECT fuzz invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-stage-")))
    const upstream = NodeHttp.createServer((req, res) => {
      const auth = req.headers["authorization"] ?? ""
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ url: req.url, auth, method: req.method }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()))
    const upAddr = upstream.address() as NodeNet.AddressInfo

    const echoServer = NodeNet.createServer((socket) => {
      socket.on("data", (chunk) => {
        socket.write(Buffer.concat([Buffer.from("ECHO:"), typeof chunk === "string" ? Buffer.from(chunk) : chunk]))
      })
    })
    await new Promise<void>((resolve) => echoServer.listen(0, "127.0.0.1", () => resolve()))
    const echoAddr = echoServer.address() as NodeNet.AddressInfo

    try {
      const ws = NodePath.join(tmpRoot, "ws")
      await Fs.mkdir(NodePath.join(ws, "src/deep"), { recursive: true })
      await Fs.mkdir(NodePath.join(ws, "node_modules/dep"), { recursive: true })
      await Fs.mkdir(NodePath.join(ws, "dist"), { recursive: true })
      await Fs.mkdir(NodePath.join(ws, "restored"), { recursive: true })
      await Fs.writeFile(NodePath.join(ws, "src/a.ts"), "export const a = 1\n", "utf8")
      await Fs.writeFile(NodePath.join(ws, "src/deep/b.ts"), "export const b = 2\n", "utf8")
      await Fs.chmod(NodePath.join(ws, "src/deep/b.ts"), 0o755)
      await Fs.writeFile(NodePath.join(ws, "src/.env"), "SECRET=top\n", "utf8")
      await Fs.writeFile(NodePath.join(ws, "node_modules/dep/index.js"), "module.exports = 1\n", "utf8")
      await Fs.writeFile(NodePath.join(ws, "dist/kept.d.ts"), "export {}\n", "utf8")
      await Fs.writeFile(NodePath.join(ws, "dist/old.js"), "old\n", "utf8")
      const at = (p: string) => NodePath.join(ws, p)

      const arb = Arbitrary.schema(
        Schema.Struct({
          scratch: Schema.Boolean,
          linkFails: Schema.Boolean,
          tunnelCase: Schema.Literals(["ok", "with-head", "sync-throw", "upstream-err", "timeout", "teardown"]),
          secretName: Schema.Literals(["API_TOKEN", "MISSING_TOKEN", "BAD_NEWLINE"]),
          reqPath: Schema.Literals(["/v1/ok", "/v1/data"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ scratch, linkFails, tunnelCase, secretName, reqPath }) =>
            Effect.gen(function*() {
              // 1. ExecStage.prepare + release
              if (process.platform !== "win32") {
                const plan: ProcessSandbox.Plan = {
                  mechanism: { _tag: "bubblewrap", executable: "/usr/bin/bwrap" },
                  network: "none",
                  workspaceRoot: ws,
                  cwd: at("src"),
                  reads: [ws, "/usr/share", at("src/a.ts"), at("src/deep/b.ts"), at("src/.env"), at("node_modules"), at("dist/kept.d.ts")],
                  links: [
                    { path: at("src/link.ts"), target: "a.ts" },
                    { path: at("node_modules/.bin/tool"), target: "../dep/index.js" }
                  ],
                  readDenies: [],
                  writes: [at("dist"), at("out/new"), "/elsewhere"],
                  readOnly: [],
                  externalReads: [],
                  hidden: { prefixes: [".env"], paths: [at("src/.env")], restored: [at("restored")] },
                  ...(scratch ? { scratch: true } : {}),
                  tmp: NodePath.join(tmpRoot, "run"),
                  uid: process.getuid?.(),
                  gid: process.getgid?.()
                }
                const io = linkFails
                  ? {
                    ...ExecStage.liveIo,
                    link: () => {
                      throw Object.assign(new Error("EXDEV"), { code: "EXDEV" })
                    }
                  }
                  : ExecStage.liveIo
                const prepared = ExecStage.prepare(plan, io)
                try {
                  if (prepared.stage.writable !== scratch) throw new Error("writable mismatch")
                  if (!NodeFs.existsSync(prepared.stage.directory)) throw new Error("stage missing")
                  const stagedA = NodePath.join(prepared.stage.directory, "src/a.ts")
                  const stA = NodeFs.statSync(stagedA)
                  const origA = NodeFs.statSync(at("src/a.ts"))
                  if (!scratch && !linkFails && stA.ino !== origA.ino) throw new Error("expected hardlink")
                  if ((scratch || linkFails) && stA.ino === origA.ino) throw new Error("expected copy")
                } finally {
                  prepared.release()
                }
                if (NodeFs.existsSync(prepared.stage.directory)) throw new Error("stage not released")
              }

              // 2. SecretProxyTunnel.connectTunnel
              yield* Effect.promise(async () => {
                const tunnels = new Set<() => void>()
                const srv = NodeNet.createServer((clientSock) => {
                  if (tunnelCase === "ok" || tunnelCase === "with-head") {
                    const head = tunnelCase === "with-head" ? Buffer.from("HEAD") : Buffer.alloc(0)
                    SecretProxyTunnel.connectTunnel(
                      clientSock,
                      { host: "127.0.0.1", port: echoAddr.port },
                      head,
                      tunnels,
                      5_000,
                      { connect: NodeNet.connect, setTimeout, clearTimeout }
                    )
                  } else if (tunnelCase === "sync-throw") {
                    SecretProxyTunnel.connectTunnel(
                      clientSock,
                      { host: "127.0.0.1", port: 1 },
                      Buffer.alloc(0),
                      tunnels,
                      5_000,
                      {
                        connect: () => {
                          throw new Error("boom")
                        },
                        setTimeout,
                        clearTimeout
                      }
                    )
                  } else if (tunnelCase === "upstream-err") {
                    SecretProxyTunnel.connectTunnel(
                      clientSock,
                      { host: "127.0.0.1", port: 1 },
                      Buffer.alloc(0),
                      tunnels,
                      5_000,
                      { connect: NodeNet.connect, setTimeout, clearTimeout }
                    )
                  } else if (tunnelCase === "timeout") {
                    const blackhole = new NodeNet.Socket()
                    SecretProxyTunnel.connectTunnel(
                      clientSock,
                      { host: "127.0.0.1", port: echoAddr.port },
                      Buffer.alloc(0),
                      tunnels,
                      15,
                      {
                        connect: () => blackhole,
                        setTimeout,
                        clearTimeout
                      }
                    )
                  } else {
                    const pending = new NodeNet.Socket()
                    SecretProxyTunnel.connectTunnel(
                      clientSock,
                      { host: "127.0.0.1", port: echoAddr.port },
                      Buffer.alloc(0),
                      tunnels,
                      5_000,
                      { connect: () => pending, setTimeout, clearTimeout }
                    )
                    for (const fn of [...tunnels]) fn()
                    clientSock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
                  }
                })
                await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()))
                const srvPort = (srv.address() as NodeNet.AddressInfo).port
                try {
                  const data = await new Promise<string>((resolve) => {
                    const sock = NodeNet.connect({ host: "127.0.0.1", port: srvPort }, () => {
                      if (tunnelCase === "ok") sock.write("PING")
                    })
                    let acc = ""
                    sock.on("data", (c) => {
                      acc += c.toString("utf8")
                      if (
                        (tunnelCase === "ok" && acc.includes("ECHO:PING")) ||
                        (tunnelCase === "with-head" && acc.includes("ECHO:HEAD")) ||
                        acc.includes("502 Bad Gateway")
                      ) {
                        sock.destroy()
                      }
                    })
                    sock.on("close", () => resolve(acc))
                    sock.on("error", () => resolve(acc))
                  })
                  if ((tunnelCase === "ok" || tunnelCase === "with-head") && !data.includes("200 Connection Established")) {
                    throw new Error(`expected 200 tunnel, got: ${data}`)
                  }
                  if (
                    (tunnelCase === "sync-throw" || tunnelCase === "upstream-err" || tunnelCase === "timeout") &&
                    !data.includes("502")
                  ) {
                    throw new Error(`expected 502, got: ${data}`)
                  }
                } finally {
                  await new Promise<void>((resolve) => srv.close(() => resolve()))
                }
              })

              // 3. SecretProxy.makeVault + startProxy with real upstream HTTP request & redaction
              yield* Effect.promise(async () => {
                const vault = SecretProxy.makeVault({
                  read: (name) =>
                    name === "API_TOKEN"
                      ? "super-secret-token-value"
                      : name === "BAD_NEWLINE"
                      ? "bad\r\nvalue"
                      : undefined
                })
                const origin = `http://127.0.0.1:${upAddr.port}`
                const sec = Secret.Secret(secretName)
                const cred = Secret.HttpSecret(sec, [origin])
                const placeholder = vault.mint(cred)
                const proxy = await SecretProxy.startProxy(vault)
                try {
                  const proxyPort = Number(new URL(proxy.endpoint).port)
                  const boundOrigin = await proxy.originFor(origin)
                  const boundPort = Number(new URL(boundOrigin).port)
                  void proxy.urlFor(sec)
                  const resp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
                    const req = NodeHttp.request(
                      {
                        host: "127.0.0.1",
                        port: secretName === "API_TOKEN" ? boundPort : proxyPort,
                        method: "GET",
                        path: secretName === "API_TOKEN" ? reqPath : `${origin}${reqPath}`,
                        headers: {
                          Host: `127.0.0.1:${upAddr.port}`,
                          Authorization: `Bearer ${placeholder}`
                        }
                      },
                      (res) => {
                        let body = ""
                        res.on("data", (d) => (body += d.toString("utf8")))
                        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
                      }
                    )
                    req.on("error", reject)
                    req.end()
                  })
                  if (secretName === "API_TOKEN") {
                    if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}: ${resp.body}`)
                    // Response must NEVER leak the raw secret back (vault redacts it to placeholder!)
                    if (resp.body.includes("super-secret-token-value")) {
                      throw new Error("raw secret leaked in response!")
                    }
                    if (!resp.body.includes(placeholder)) {
                      throw new Error(`expected redacted placeholder in response: ${resp.body}`)
                    }
                  } else {
                    if (resp.status === 200) throw new Error(`expected non-200 for ${secretName}`)
                  }
                } finally {
                  await proxy.close()
                }
              })

              return true
            }),
          { executions: fsExecutions, seed: seed + 1 }
        )
      )
      assertPassed(report)
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      await new Promise<void>((resolve) => echoServer.close(() => resolve()))
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }, 120_000)

  it("PackageDefaults, Config, DepsLint & Install validation, matching, synthesis & planning fuzz invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pkgName: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,12}$/)),
        cacheDir: Schema.Literals([
          ".flows",
          "  .cache/build  ",
          "./sub/dir/",
          "../outside",
          "/abs/path",
          "",
          "   ",
          ".",
          "a\u0000b",
          "a".repeat(260)
        ]),
        sandbox: Schema.Literals(["none", "default", "loopback", "true", "false", "bad"]),
        gitignored: Schema.Boolean,
        isBun: Schema.Boolean,
        useManifest: Schema.Boolean,
        excludeMatch: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ pkgName, cacheDir, sandbox, gitignored, isBun, useManifest, excludeMatch }) =>
          Effect.sync(() => {
            // 1. PackageDefaults
            const dir = excludeMatch ? "packages/vendor" : `packages/${pkgName}`
            const decl = PackageDefaults.PackageDefaults({
              directories: Input.glob("packages/*", { exclude: ["packages/vendor"] }),
              marker: "package.json",
              unless: "PACKAGE.ts",
              attrs: { extra: "yes" },
              macro: ((attrs: { readonly cwd: string; readonly extra?: string }) => ({
                b_test: Shell.Test({ shell: "true" }),
                a_manifest: PackageJson.PackageJson({
                  name: `@demo/${pkgName}`,
                  version: "0.0.1",
                  description: "demo",
                  license: "MIT"
                }),
                ignored: 123
              })) as PackageDefaults.Macro
            })
            if (!PackageDefaults.isPackageDefaults(decl)) throw new Error("isPackageDefaults true")
            if (PackageDefaults.isPackageDefaults(null)) throw new Error("isPackageDefaults null")
            if (PackageDefaults.isPackageDefaults({})) throw new Error("isPackageDefaults empty")
            if (PackageDefaults.isPackageDefaults(new Proxy(decl, {}))) throw new Error("proxy rejected")
            if (PackageDefaults.matches(decl, "", dir) !== !excludeMatch) throw new Error("matches")
            if (PackageDefaults.matches(decl, "", "packages/.smthrs-scaffold-123.tmp")) {
              throw new Error("scaffold tmp must not match")
            }
            const exp = PackageDefaults.expand(decl, `packages/${pkgName}`)
            if (exp.targets.length !== 1 || exp.declarations.length !== 1) throw new Error("expand counts")
            const synth = PackageDefaults.synthesize(decl, `packages/${pkgName}`)
            if (synth.length !== 1 || synth[0]?.[0] !== "b_test") throw new Error("synthesize")

            // Error cases in PackageDefaults.expand
            const emptyDecl = PackageDefaults.make({ directories: "packages/*", macro: (() => ({})) as PackageDefaults.Macro })
            let threwEmpty = false
            try {
              PackageDefaults.expand(emptyDecl, "packages/a")
            } catch {
              threwEmpty = true
            }
            if (!threwEmpty) throw new Error("expected empty expand throw")
            const badDecl = PackageDefaults.make({ directories: "packages/*", macro: (() => null as never) as PackageDefaults.Macro })
            let threwBad = false
            try {
              PackageDefaults.expand(badDecl, "packages/a")
            } catch (e) {
              if (e instanceof TypeError) threwBad = true
            }
            if (!threwBad) throw new Error("expected bad expand TypeError")

            // 2. Config.Workspace & cache dir normalization
            const validDeclared = cacheDir === ".flows" || cacheDir === "  .cache/build  " || cacheDir === "./sub/dir/"
            const validNormalized = validDeclared || cacheDir === "../outside"
            try {
              const norm = Config.normalizeDeclaredCacheDirectory(cacheDir)
              if (!validDeclared) throw new Error(`should reject declared ${cacheDir}`)
              if (Config.isOutsideCacheDirectory(norm)) throw new Error("declared cannot be outside")
            } catch (e) {
              if (validDeclared) throw e
            }
            try {
              const norm = Config.normalizeCacheDirectory(cacheDir)
              if (!validNormalized) throw new Error(`should reject normalized ${cacheDir}`)
              if (cacheDir === "../outside" && !Config.isOutsideCacheDirectory(norm)) throw new Error("outside flag")
            } catch (e) {
              if (validNormalized) throw e
            }

            const sbVal =
              sandbox === "none"
                ? "none"
                : sandbox === "default"
                ? {}
                : sandbox === "loopback"
                ? { network: "loopback" as const }
                : sandbox === "true"
                ? { network: true }
                : sandbox === "false"
                ? { network: false }
                : ({ network: "invalid", extra: 1 } as never)

            if (Config.isSandboxPolicy(sbVal) !== (sandbox !== "bad")) throw new Error("isSandboxPolicy")
            if (validDeclared && sandbox !== "bad") {
              const sandboxes = WorkspaceDeclaration.Sandboxes({ default: WorkspaceDeclaration.Sandbox.Bubblewrap() })
              const ws = Config.Workspace({ cacheDirectory: cacheDir, gitignored, sandbox: sbVal, sandboxes })
              if (!Config.isWorkspace(ws)) throw new Error("isWorkspace")
              if (Config.isWorkspace(new Proxy(ws, {}))) throw new Error("proxy ws")
            } else if (sandbox === "bad") {
              let threw = false
              try {
                Config.Workspace({ sandbox: sbVal })
              } catch (e) {
                if (e instanceof TypeError) threw = true
              }
              if (!threw) throw new Error("expected bad sandbox TypeError")
            }

            // Unknown option, symbol prop, non-plain, getter rejections
            for (const badOpts of [
              null,
              new Proxy({}, {}),
              { unknown: 1 },
              { [Symbol("s")]: 1 },
              Object.defineProperty({}, "gitignored", { get: () => true, enumerable: true }),
              { cacheDirectory: 123 },
              { gitignored: "yes" },
              { sandboxes: {} }
            ]) {
              let threw = false
              try {
                Config.Workspace(badOpts as never)
              } catch (e) {
                if (e instanceof TypeError) threw = true
              }
              if (!threw) throw new Error("expected Config.Workspace TypeError")
            }

            // 3. DepsLint & Install planning
            const depsCalls = plannedCalls(
              DepsLint.DepsLint({
                packageManager,
                runtime,
                packageJson: Input.file(`packages/${pkgName}/package.json`),
                sources: [Input.glob(`packages/${pkgName}/src/**`)],
                deps: [],
                cwd: `packages/${pkgName}`,
                tool: "knip",
                ignoreDependencies: ["opt-dep"],
                ignoreBinaries: ["opt-bin"]
              })
            )
            if (depsCalls.length !== 2) throw new Error("DepsLint calls")

            const pm = isBun ? PackageManager.BunPackages({ runtime: Runtime.Bun({ version: ">=1.4.0" }) }) : packageManager
            const inst = Install.Install({
              packageManager: pm,
              ...(useManifest ? { workspaceManifest: Input.pnpmWorkspace("pnpm-workspace.yaml") } : {})
            })
            const instInputs = Install.inputsFor(Target.metadata(inst).attrs as Install.Attrs)
            if (instInputs.length < 3) throw new Error("Install inputs")
            const instCalls = plannedCalls(inst)
            if (instCalls.length !== 1) throw new Error("Install calls")
            const inferredBun = Install.inputsFor(
              Install.Attrs.make({ lockfilePath: "bun.lock" })
            )
            if (!inferredBun.some((i) => i._tag === "Glob")) throw new Error("bun patch glob")

            return true
          }),
        { executions, seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("JobKeeper OS inspection helpers & live namespace keeper/client step fuzz invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-jk-")))
    try {
      // Pure & host OS helpers
      const procs = await JobKeeper.processes()
      expect(procs.size).toBeGreaterThan(0)
      const selfChildren = JobKeeper.childrenOf(process.pid)
      expect(Array.isArray(selfChildren)).toBe(true)
      const cmdLine = JobKeeper.commandLineOf(process.pid)
      expect(typeof cmdLine).toBe("string")
      const still = JobKeeper.stillIn([999_999_999])
      expect(still).toEqual([])
      const endedRes = await JobKeeper.endedOrNamed([999_999_999], 200)
      expect(endedRes).toBeUndefined()
      const allEndedRes = await JobKeeper.allEnded([999_999_999], 200)
      expect(allEndedRes).toBe(true)
      const said: Array<string> = []
      await JobKeeper.endsOrSays([999_999_999], (line) => said.push(line), "prefix: ", 200)
      expect(said).toEqual([])
      const leftFile = NodePath.join(tmpRoot, "left.json")
      await Fs.writeFile(`${leftFile}.cpu`, "42.5", "utf8")
      expect(await JobKeeper.cpuAt(leftFile)).toBe(42.5)
      expect(await JobKeeper.cpuAt(NodePath.join(tmpRoot, "missing.json"))).toBeUndefined()
      const orphans = await JobKeeper.orphansIn(procs, tmpRoot)
      expect(Array.isArray(orphans)).toBe(true)
      const endedOrphans = await JobKeeper.endOrphans(procs, tmpRoot)
      expect(Array.isArray(endedOrphans)).toBe(true)

      // Live bwrap keeper + client step if bwrap is available on Linux
      const bwrapPath = (() => {
        if (process.platform !== "linux") return undefined
        const found = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).stdout.trim()
        if (found === "") return undefined
        const tried = spawnSync(found, ["--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--", "true"])
        return tried.status === 0 ? found : undefined
      })()

      if (bwrapPath !== undefined) {
        const dir = NodePath.join(tmpRoot, "job")
        await Fs.mkdir(dir, { recursive: true })
        const argv = JobKeeper.namespaced(bwrapPath, [], JobKeeper.keeper(process.execPath))
        const keeper = spawn(argv[0], argv.slice(1), {
          cwd: dir,
          stdio: ["ignore", "ignore", "ignore"],
          env: { PATH: process.env["PATH"] }
        })
        try {
          for (let waited = 0; !NodeFs.existsSync(NodePath.join(dir, JobKeeper.socketName)); waited += 20) {
            if (waited > 10_000) throw new Error("keeper did not listen")
            await new Promise((r) => setTimeout(r, 20))
          }
          const arb = Arbitrary.schema(
            Schema.Struct({
              code: Schema.Literals([0, 2, 7]),
              msg: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,10}$/))
            })
          )
          let stepN = 0
          const report = await Effect.runPromise(
            Fuzz.run(
              arb,
              ({ code, msg }) =>
                Effect.promise(async () => {
                  const leftPath = NodePath.join(dir, `left-${++stepN}.json`)
                  const cArgv = JobKeeper.client(
                    process.execPath,
                    dir,
                    ["sh", "-c", `printf "%s" ${JSON.stringify(msg)}; exit ${code}`],
                    { left: leftPath }
                  )
                  const out = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
                    const child = spawn(cArgv[0], cArgv.slice(1), {
                      env: { PATH: process.env["PATH"] },
                      stdio: ["ignore", "pipe", "pipe"]
                    })
                    let stdout = ""
                    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
                    child.on("close", (status) => resolve({ status, stdout }))
                  })
                  if (out.status !== code) throw new Error(`expected ${code}, got ${out.status}`)
                  if (out.stdout !== msg) throw new Error(`expected ${msg}, got ${out.stdout}`)
                  const cpu = await JobKeeper.cpuAt(leftPath)
                  if (typeof cpu !== "number") throw new Error("expected cpu number")
                  return true
                }),
              { executions: Math.min(executions, 5), seed: seed + 3 }
            )
          )
          assertPassed(report)
        } finally {
          keeper.kill("SIGKILL")
          await new Promise<void>((resolve) => {
            if (keeper.exitCode !== null || keeper.signalCode !== null) return resolve()
            keeper.once("exit", () => resolve())
          })
        }
      }
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
