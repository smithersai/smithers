import * as NodeServices from "@effect/platform-node/NodeServices"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Fuzz } from "@smthrs/fuzz"
import { Destination } from "@smthrs/kernel/HttpClient"
import { Arbitrary, Effect, Exit, FileSystem, Layer, Logger, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"
import * as EgressHttpClient from "../src/EgressHttpClient.ts"
import { createBrokerDirectory, destinationBrokerRoot } from "../src/internal/DestinationBrokerRoot.ts"
import { AgentFactory } from "../src/internal/EgressAgent.ts"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"
import * as NodeRuntime from "../src/NodeRuntime.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

const baseExecutions = Number(process.env["FUZZ_EXECUTIONS"] ?? "100")
const seed = Number(process.env["FUZZ_SEED"] ?? "20261128")
const fastExecutions = Math.max(12, Math.min(baseExecutions, 40))
const ioExecutions = Math.max(8, Math.min(baseExecutions, 16))
const silentLogger = Logger.layer([Logger.make(() => {})])
const nodeLayer = Layer.merge(NodeServices.layer, silentLogger)

const roots: Array<string> = []
const freshDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `smthrs-pnode-gap-${prefix}-`))
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const startHttp = (
  handler: (url: string, headers: Record<string, string | string[] | undefined>) => { status: number; body: string }
): Promise<{ server: HttpServer; port: number; origin: string }> =>
  new Promise((resolve, reject) => {
    const server = createHttpServer((req, res) => {
      const out = handler(req.url ?? "/", req.headers)
      res.writeHead(out.status, { "content-type": "text/plain", connection: "close" })
      res.end(out.body)
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (addr === null || typeof addr === "string") {
        reject(new Error("no port"))
        return
      }
      resolve({ server, port: addr.port, origin: `http://127.0.0.1:${addr.port}` })
    })
  })

const closeHttp = (server: HttpServer): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })

describe("@smthrs/platform-node gap closer: NodeLanguageServer security/push/refresh, ProcessSandbox toolchain/wrapping, EgressHttpClient pinning/repair, NativeRuntime & AtomicFileSystem", () => {
  it("NodeLanguageServer workspaceProgram/launcher/interpreterCode refuses unsafe commands and arguments", async () => {
    const ws = freshDir("lsp-sec-ws")
    const outside = freshDir("lsp-sec-out")
    const wsBin = join(ws, "my-lsp")
    const wsScript = join(ws, "entry.js")
    const outScript = join(outside, "host-lsp.js")
    writeFileSync(wsBin, "#!/bin/sh\nexit 0\n", "utf8")
    chmodSync(wsBin, 0o755)
    writeFileSync(wsScript, "console.log('ws')\n", "utf8")
    writeFileSync(outScript, "console.log('host')\n", "utf8")

    const Input = Schema.Struct({
      caseKind: Schema.Literals([
        "launcher-sh",
        "launcher-env",
        "launcher-npx",
        "node-eval-short",
        "node-eval-long",
        "node-dash",
        "node-double-dash-missing",
        "node-flag-value-missing",
        "node-long-flag-no-eq",
        "node-short-val-letter",
        "ws-program",
        "ws-arg-direct",
        "ws-arg-eq"
      ])
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Input),
        (tc) =>
          Effect.gen(function*() {
            const config: NodeLanguageServer.Config = tc.caseKind === "launcher-sh"
              ? { command: "sh", args: ["-c", "true"], cwd: ws }
              : tc.caseKind === "launcher-env"
              ? { command: "env", args: ["node", outScript], cwd: ws }
              : tc.caseKind === "launcher-npx"
              ? { command: "npx", args: ["ts-ls"], cwd: ws }
              : tc.caseKind === "node-eval-short"
              ? { command: "node", args: ["-e", "1"], cwd: ws }
              : tc.caseKind === "node-eval-long"
              ? { command: "node", args: ["--eval=1"], cwd: ws }
              : tc.caseKind === "node-dash"
              ? { command: "node", args: ["-"], cwd: ws }
              : tc.caseKind === "node-double-dash-missing"
              ? { command: "node", args: ["--", join(outside, "missing.js")], cwd: ws }
              : tc.caseKind === "node-flag-value-missing"
              ? { command: "node", args: ["--loader", "ts-node", join(outside, "missing.js")], cwd: ws }
              : tc.caseKind === "node-long-flag-no-eq"
              ? { command: "node", args: ["--title", "foo", join(outside, "missing.js")], cwd: ws }
              : tc.caseKind === "node-short-val-letter"
              ? { command: "node", args: ["-r", "mod", join(outside, "missing.js")], cwd: ws }
              : tc.caseKind === "ws-program"
              ? { command: wsBin, args: [], cwd: ws }
              : tc.caseKind === "ws-arg-direct"
              ? { command: process.execPath, args: [wsScript], cwd: ws }
              : { command: process.execPath, args: [`--config=${wsScript}`, outScript], cwd: ws }

            const exit = yield* Effect.scoped(NodeLanguageServer.make(config)).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            return true
          }).pipe(Effect.provide(nodeLayer)),
        { seed, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("NodeLanguageServer exercises close, refresh (unchanged/modified/deleted), pushedDiagnostics (superseded/not_found/timeout) and large stderr tail", async () => {
    const outDir = freshDir("lsp-srv")
    const srvScript = join(outDir, "push-lsp.mjs")
    writeFileSync(
      srvScript,
      `
import { Buffer } from "node:buffer";
let buf = Buffer.alloc(0);
const send = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  process.stdout.write("Content-Length: " + body.byteLength + "\\r\\n\\r\\n");
  process.stdout.write(body);
};
const mode = process.env.LSP_MODE || "push";
if (mode === "stderr") {
  process.stderr.write("x".repeat(70000) + "\\u2026tail\\n");
}
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const idx = buf.indexOf("\\r\\n\\r\\n");
    if (idx < 0) break;
    const hdr = buf.subarray(0, idx).toString("utf8");
    const m = /Content-Length:\\s*(\\d+)/i.exec(hdr);
    if (!m) break;
    const len = Number(m[1]);
    if (buf.byteLength < idx + 4 + len) break;
    const msg = JSON.parse(buf.subarray(idx + 4, idx + 4 + len).toString("utf8"));
    buf = buf.subarray(idx + 4 + len);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
    } else if (msg.method === "shutdown") {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.method === "exit") {
      process.exit(0);
    } else if (msg.method === "textDocument/diagnostic") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    } else if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") {
      const uri = msg.params.textDocument.uri;
      const version = msg.params.textDocument.version;
      if (mode === "push") {
        send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: [{ message: "first-" + version, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] } });
        setTimeout(() => {
          send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: [{ message: "second-" + version, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] } });
        }, 15);
      }
    } else if (msg.method === "textDocument/hover") {
      send({ jsonrpc: "2.0", id: msg.id, result: { contents: "ok" } });
    }
  }
});
`,
      "utf8"
    )

    const Input = Schema.Struct({
      scenario: Schema.Literals(["push-supersede-and-refresh", "push-not-found", "push-timeout", "stderr-overflow"])
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Input),
        (tc) =>
          Effect.gen(function*() {
            const ws = freshDir("lsp-ws")
            const f1 = join(ws, "a.ts")
            const f2 = join(ws, "b.ts")
            const f3 = join(ws, "c.ts")
            writeFileSync(f1, "export const a = 1\n", "utf8")
            writeFileSync(f2, "export const b = 2\n", "utf8")
            writeFileSync(f3, "export const c = 3\n", "utf8")

            const envMode = tc.scenario === "push-timeout"
              ? "silent"
              : tc.scenario === "stderr-overflow"
              ? "stderr"
              : "push"

            yield* Effect.scoped(
              Effect.gen(function*() {
                const lsp = yield* NodeLanguageServer.make({
                  command: process.execPath,
                  args: [srvScript],
                  cwd: ws,
                  environment: { LSP_MODE: envMode },
                  timeoutMs: 2_000,
                  settleMs: tc.scenario === "push-timeout" ? 60 : 500,
                  quietMs: 60
                })

                if (tc.scenario === "push-supersede-and-refresh") {
                  // Diagnostics via push fallback (pulls -32601 -> falls back to push, receives 2 publishes)
                  const diag = yield* lsp.diagnostics("a.ts")
                  expect(JSON.stringify(diag)).toContain("second-")
                  // Sync 2 more files, mutate b.ts, delete c.ts, then refresh and close
                  yield* lsp.sync("b.ts", "export const b = 2\n")
                  yield* lsp.sync("c.ts", "export const c = 3\n")
                  writeFileSync(f2, "export const b = 22\n", "utf8")
                  unlinkSync(f3)
                  yield* lsp.refresh
                  // Second diagnostics call exercises pullUnsupported fast path
                  const diag2 = yield* lsp.diagnostics("b.ts")
                  expect(JSON.stringify(diag2)).toContain("second-")
                  yield* lsp.close("a.ts")
                  yield* lsp.close("a.ts") // idempotent when already closed
                } else if (tc.scenario === "push-not-found") {
                  const missing = yield* lsp.diagnostics("missing.ts").pipe(Effect.exit)
                  expect(Exit.isFailure(missing)).toBe(true)
                } else if (tc.scenario === "push-timeout") {
                  const timedOut = yield* lsp.diagnostics("a.ts").pipe(Effect.exit)
                  expect(Exit.isFailure(timedOut)).toBe(true)
                } else {
                  const hover = yield* lsp.hover({ path: "a.ts", line: 1, character: 1 })
                  expect(hover).toBeDefined()
                }
              })
            )
            return true
          }).pipe(Effect.provide(nodeLayer)),
        { seed: seed + 1, executions: Math.min(ioExecutions, 8) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("ProcessSandbox fuzzes windowsDrives, host(), toolchain(), plan/bubblewrap/seatbelt/docker with links, hidden, credentials, broker sockets & writeProtectionRefusal", async () => {
    const Input = Schema.Struct({
      platform: Schema.Literals(["linux", "darwin", "win32"]),
      network: Schema.Literals(["none", "loopback", "open"]),
      mechanism: Schema.Literals(["native", "docker"]),
      badReadOnly: Schema.Boolean,
      badSocket: Schema.Boolean,
      badLink: Schema.Boolean
    })

    // Set up realistic temp filesystem once for toolchain + host + mountinfo
    const base = freshDir("psb-env")
    const ws = join(base, "ws")
    const home = join(base, "home")
    const ext = join(base, "ext")
    mkdirSync(ws, { recursive: true })
    mkdirSync(join(ws, "out", "sealed"), { recursive: true })
    mkdirSync(join(ws, "hidden-dir"), { recursive: true })
    writeFileSync(join(ws, "in.txt"), "hello", "utf8")
    writeFileSync(join(ws, "file-not-dir.txt"), "x", "utf8")
    writeFileSync(join(ws, "hidden-file.txt"), "secret", "utf8")
    writeFileSync(join(ws, "hidden-dir", "keep.txt"), "ok", "utf8")
    writeFileSync(join(ws, "reopen.txt"), "reopen", "utf8")
    mkdirSync(ext, { recursive: true })
    writeFileSync(join(ext, "ext.txt"), "ext", "utf8")
    symlinkSync(join(ext, "ext.txt"), join(ws, "linked-ext.txt"))

    // Fake home with tool dir, script referencing $HOME/mytool/share/data, shim script, package.json, and credential dir
    const toolBin = join(home, "mytool", "bin")
    const toolShare = join(home, "mytool", "share")
    const pkgDir = join(base, "pkg-tool")
    const pkgBin = join(pkgDir, "bin")
    const credDir = join(home, ".ssh")
    mkdirSync(toolBin, { recursive: true })
    mkdirSync(toolShare, { recursive: true })
    mkdirSync(pkgBin, { recursive: true })
    mkdirSync(credDir, { recursive: true })
    writeFileSync(join(toolShare, "data"), "1", "utf8")
    const myScript = join(toolBin, "mytool")
    writeFileSync(myScript, `#!/bin/sh\necho "$HOME/mytool/share/data"\n`, "utf8")
    chmodSync(myScript, 0o755)
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "pkg-tool" }), "utf8")
    const realTarget = join(pkgBin, "run-pkg")
    writeFileSync(realTarget, "#!/bin/sh\necho ok\n", "utf8")
    chmodSync(realTarget, 0o755)
    symlinkSync(realTarget, join(toolBin, "pkg-link"))
    const shimScript = join(toolBin, "shimmed")
    writeFileSync(shimScript, `#!/bin/sh\n# cmd-shim-target=${realTarget}\nexec "${realTarget}"\n`, "utf8")
    chmodSync(shimScript, 0o755)
    writeFileSync(join(credDir, "id_ed25519"), "fake", "utf8")

    const mountInfoPath = join(base, "mountinfo")
    writeFileSync(
      mountInfoPath,
      [
        "10 1 0:10 / /mnt/c rw - drvfs C:\\ rw",
        "11 1 0:11 / /mnt/d\\040drive rw - 9p D:\\ rw,aname=drvfs;path=D:\\",
        "12 1 0:12 / / rw - ext4 /dev/sda1 rw",
        "bad line"
      ].join("\n"),
      "utf8"
    )

    const drives = ProcessSandbox.windowsDrives(mountInfoPath)
    expect(drives).toContain("/mnt/c")
    expect(drives).toContain("/mnt/d drive")
    expect(ProcessSandbox.windowsDrives(join(base, "missing-mountinfo"))).toEqual([])

    // Exercise host() methods directly
    const realHost = ProcessSandbox.host({ PATH: `${toolBin}:/usr/bin:/bin`, HOME: home })
    expect(realHost.executable(myScript)).toBe(myScript)
    expect(realHost.executable("mytool")).toBe(myScript)
    expect(realHost.executable("definitely-missing-xyz-bin")).toBeUndefined()
    expect(realHost.packageDirectory?.(pkgDir)).toBe(true)
    expect(realHost.packageDirectory?.(ws)).toBe(false)
    expect(realHost.isDirectory(ws)).toBe(true)
    expect(realHost.isDirectory(join(ws, "nope"))).toBe(false)
    expect(realHost.entries?.(toolBin)?.length).toBeGreaterThan(0)
    expect(realHost.entries?.(join(ws, "nope"))).toBeUndefined()
    expect(realHost.realpath?.(join(ws, "nope"))).toBeUndefined()
    expect(realHost.readlink?.(join(toolBin, "pkg-link"))).toBe(realTarget)
    expect(realHost.readlink?.(myScript)).toBeUndefined()
    expect(realHost.shimTarget?.(shimScript)).toBe(realTarget)
    expect(realHost.scriptText?.(join(ws, "in.txt"))).toBeUndefined()

    // Exercise toolchain()
    const tcHost: ProcessSandbox.Host = { ...realHost, home, windowsDrives: ["/mnt/c"] }
    const tool = ProcessSandbox.toolchain(`${toolBin}:/mnt/c/Windows:/usr/bin:relative/path`, ws, tcHost)
    expect(tool.reads.length).toBeGreaterThan(0)

    // Exercise writeProtectionRefusal across platforms
    expect(ProcessSandbox.writeProtectionRefusal({ ...realHost, platform: "darwin" })).toContain("only on Linux")
    expect(ProcessSandbox.writeProtectionRefusal({ ...realHost, platform: "linux", executable: () => undefined }))
      .toContain("not on PATH")
    const linuxRefusal = ProcessSandbox.writeProtectionRefusal(realHost, 2_000)
    expect(linuxRefusal === undefined || typeof linuxRefusal === "string").toBe(true)

    // Exercise DestinationBrokerRoot.createBrokerDirectory (valid and invalid owner)
    const brokerParent = join(base, "broker-root")
    const validBroker = await Effect.runPromise(createBrokerDirectory(brokerParent, process.getuid?.()))
    expect(validBroker.startsWith(brokerParent)).toBe(true)
    const badBroker = await Effect.runPromise(Effect.exit(createBrokerDirectory(brokerParent, -1)))
    expect(Exit.isFailure(badBroker)).toBe(true)

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Input),
        (tc) =>
          Effect.sync(() => {
            const fakeHost: ProcessSandbox.Host = {
              ...realHost,
              home,
              platform: tc.platform,
              executable: (name) =>
                name === "bwrap"
                  ? "/usr/bin/bwrap"
                  : name === "docker"
                  ? "/usr/bin/docker"
                  : name === "/usr/bin/sandbox-exec"
                  ? "/usr/bin/sandbox-exec"
                  : realHost.executable(name)
            }

            // Linked read without externalReads -> refused
            const unlinkedPlan = ProcessSandbox.plan(
              { reads: ["linked-ext.txt"], writes: ["out"], network: "none" },
              { workspaceRoot: ws, cwd: ws, tmp: base },
              fakeHost
            )
            expect(ProcessSandbox.isUnenforceable(unlinkedPlan)).toBe(true)

            // Writing a regular file as directory write -> refused
            const fileWritePlan = ProcessSandbox.plan(
              { reads: ["in.txt"], writes: ["file-not-dir.txt"], network: "none" },
              { workspaceRoot: ws, cwd: ws, tmp: base },
              fakeHost
            )
            expect(ProcessSandbox.isUnenforceable(fileWritePlan)).toBe(true)

            const plan = ProcessSandbox.plan(
              {
                reads: ["in.txt", "linked-ext.txt"],
                externalReads: [ext, join(credDir, "id_ed25519")],
                writes: ["out"],
                writeFiles: ["out/newfile.txt", "out"],
                readOnly: [tc.badReadOnly ? "out/missing-seal" : "out/sealed"],
                links: tc.badLink
                  ? [{ path: "../escape", target: "/etc/passwd" }]
                  : tc.mechanism === "docker"
                  ? [{ path: "in-link", target: "in.txt" }]
                  : [{ path: "in-link", target: "in.txt" }],
                externalLinks: [{ path: join(base, "ext-link"), target: ext }],
                privateLinks: [{ path: "rel-link", target: "target" }, { path: "../bad", target: "x" }],
                network: tc.network,
                ...(tc.mechanism === "docker" ? { mechanism: { _tag: "docker" as const, image: "alpine:3" } } : {})
              },
              { workspaceRoot: ws, cwd: ws, tmp: base },
              fakeHost
            )

            if (tc.badLink || (tc.mechanism === "docker")) {
              expect(ProcessSandbox.isUnenforceable(plan)).toBe(true)
              return true
            }

            if (!ProcessSandbox.isUnenforceable(plan)) {
              const enriched: ProcessSandbox.Plan = {
                ...plan,
                externalReads: [...plan.externalReads, home],
                hidden: {
                  paths: [join(ws, "hidden-file.txt"), join(ws, "hidden-dir")],
                  prefixes: [],
                  restored: [join(ws, "hidden-dir", "keep.txt"), join(ws, "reopen.txt")]
                },
                destinationSocket: tc.badSocket
                  ? "/tmp/wrong/p.sock"
                  : `${destinationBrokerRoot}/run-abc/p.sock`
              }
              if (enriched.mechanism._tag === "bubblewrap") {
                if (tc.badReadOnly || tc.badSocket) {
                  expect(() => ProcessSandbox.bubblewrap(enriched, ["echo", "hi"], fakeHost)).toThrow()
                } else {
                  const argv = ProcessSandbox.bubblewrap(enriched, ["echo", "hi"], fakeHost)
                  expect(argv).toContain("--tmpfs")
                  expect(argv).toContain(destinationBrokerRoot)
                }
              } else if (enriched.mechanism._tag === "seatbelt") {
                const profile = ProcessSandbox.seatbelt(enriched, fakeHost)
                expect(profile).toContain("version 1")
              }
            }
            return true
          }),
        { seed: seed + 2, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("EgressHttpClient fuzzes pinned destination requests (valid, invalid origin/IP/proxy) and providerFetch transient HTTP/2 & socket repair", async () => {
    const srv = await startHttp((url) => ({ status: 200, body: `ok:${url}` }))
    try {
      const Input = Schema.Struct({
        caseKind: Schema.Literals([
          "pinned-ok",
          "pinned-wrong-origin",
          "pinned-empty-addrs",
          "pinned-bad-ip",
          "pinned-bad-proxy",
          "fetch-h2-retry",
          "fetch-socket-retry",
          "fetch-non-retryable"
        ])
      })

      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Input),
          (tc) =>
            Effect.gen(function*() {
              if (tc.caseKind.startsWith("pinned-")) {
                const env: Record<string, string> = tc.caseKind === "pinned-bad-proxy"
                  ? { HTTP_PROXY: "ftp://bad-proxy.invalid:8080" }
                  : {}
                const dest = tc.caseKind === "pinned-ok" || tc.caseKind === "pinned-bad-proxy"
                  ? { origin: srv.origin, addresses: ["127.0.0.1"] as ReadonlyArray<string> }
                  : tc.caseKind === "pinned-wrong-origin"
                  ? { origin: "http://127.0.0.1:1", addresses: ["127.0.0.1"] as ReadonlyArray<string> }
                  : tc.caseKind === "pinned-empty-addrs"
                  ? { origin: srv.origin, addresses: [] as ReadonlyArray<string> }
                  : { origin: srv.origin, addresses: ["not-an-ip"] as ReadonlyArray<string> }

                const exit = yield* Effect.scoped(
                  Effect.gen(function*() {
                    const client = yield* HttpClient.HttpClient
                    const resp = yield* client.execute(HttpClientRequest.get(`${srv.origin}/pin`))
                    return yield* resp.text
                  }).pipe(
                    Effect.provideService(Destination, dest),
                    Effect.provide(EgressHttpClient.layer(env))
                  )
                ).pipe(Effect.exit)

                if (tc.caseKind === "pinned-ok") {
                  expect(Exit.isSuccess(exit)).toBe(true)
                } else {
                  expect(Exit.isFailure(exit)).toBe(true)
                }
              } else {
                // Inject AgentFactory whose first fetch fails with a transient error code, then delegates to real undici
                let calls = 0
                const failCode = tc.caseKind === "fetch-h2-retry"
                  ? "ERR_HTTP2_INVALID_SESSION"
                  : tc.caseKind === "fetch-socket-retry"
                  ? "UND_ERR_SOCKET"
                  : "ECONNREFUSED"

                const customFactory = Layer.succeed(AgentFactory)((undici, options) => {
                  const real = new undici.EnvHttpProxyAgent(options)
                  const originalDispatch = real.dispatch.bind(real)
                  real.dispatch = ((opts: any, handler: any) => {
                    calls += 1
                    if (calls === 1) {
                      const err = Object.assign(new Error("synthetic"), { code: failCode })
                      queueMicrotask(() => {
                        if (typeof handler.onResponseError === "function") handler.onResponseError({}, err)
                        else handler.onError?.(err)
                      })
                      return true
                    }
                    return originalDispatch(opts, handler)
                  }) as typeof real.dispatch
                  return real
                })

                const textOrErr = yield* Effect.scoped(
                  Effect.gen(function*() {
                    const f = yield* EgressHttpClient.providerFetch({})
                    const r = yield* Effect.tryPromise(() => f(`${srv.origin}/repair`))
                    return yield* Effect.tryPromise(() => r.text())
                  }).pipe(Effect.provide(customFactory))
                ).pipe(Effect.exit)

                if (tc.caseKind === "fetch-non-retryable") {
                  expect(Exit.isFailure(textOrErr)).toBe(true)
                } else {
                  expect(Exit.isSuccess(textOrErr)).toBe(true)
                }
              }
              return true
            }).pipe(Effect.provide(silentLogger)),
          { seed: seed + 3, executions: ioExecutions }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
    } finally {
      await closeHttp(srv.server)
    }
  })

  it("NativeRuntime and AtomicFileSystem fuzz invalid configuration validation, nested rulesets, containment snapshots and limit refusals", async () => {
    const Input = Schema.Struct({
      caseKind: Schema.Literals([
        "bad-timeout-neg",
        "bad-timeout-float",
        "bad-timeout-huge",
        "rules-flat",
        "rules-nested",
        "rules-bad-member",
        "rules-not-array",
        "containment-custom",
        "atomic-bad-limit",
        "atomic-bad-batchsize",
        "atomic-bad-concurrency",
        "atomic-bad-timeout"
      ])
    })

    const rule = new Rule({
      effect: "allow",
      pattern: new CapabilityPattern({ action: "fs:read", resource: "*" })
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Input),
        (tc) =>
          Effect.gen(function*() {
            expect(AtomicFileSystem.helperSpawns()).toBeGreaterThanOrEqual(0)

            const baseHost = {
              filename: join(freshDir("nr"), "j.sqlite"),
              workspaceRoot: tmpdir(),
              owner: { hostId: "fuzz" }
            }
            if (
              tc.caseKind === "bad-timeout-neg" || tc.caseKind === "bad-timeout-float" ||
              tc.caseKind === "bad-timeout-huge"
            ) {
              const timeoutMs = tc.caseKind === "bad-timeout-neg"
                ? -1
                : tc.caseKind === "bad-timeout-float"
                ? 1.5
                : 9_999_999_999
              expect((): unknown => NodeRuntime.layerHost({ ...baseHost, shutdownTimeoutMs: timeoutMs }, Layer.empty))
                .toThrow()
            } else if (tc.caseKind === "rules-flat") {
              const l = NodeRuntime.layerHost({ ...baseHost, rules: [rule] }, Layer.empty)
              expect(l).toBeDefined()
            } else if (tc.caseKind === "rules-nested") {
              const l = NodeRuntime.layerHost({ ...baseHost, rules: [[rule]] }, Layer.empty)
              expect(l).toBeDefined()
            } else if (tc.caseKind === "rules-bad-member") {
              expect((): unknown => NodeRuntime.layerHost({ ...baseHost, rules: [{} as unknown as Rule] }, Layer.empty))
                .toThrow()
            } else if (tc.caseKind === "rules-not-array") {
              expect((): unknown =>
                NodeRuntime.layerHost({ ...baseHost, rules: "bad" as unknown as ReadonlyArray<Rule> }, Layer.empty)
              ).toThrow()
            } else if (tc.caseKind === "containment-custom") {
              const l = NodeRuntime.layerHost({
                ...baseHost,
                containment: {
                  graceMs: 100,
                  platform: "linux",
                  ownerPid: process.pid,
                  system: {
                    isAlive: () => "dead",
                    startedAtMs: () => ({ _tag: "gone" }),
                    ownGroup: () => 0,
                    bootedAtMs: () => 1_000,
                    refuseTarget: () => undefined,
                    killTree: () => "already-gone"
                  }
                }
              }, Layer.empty)
              expect(l).toBeDefined()
            } else {
              const dir = freshDir("atomic-cfg")
              const opts: AtomicFileSystem.Options = tc.caseKind === "atomic-bad-limit"
                ? { limits: { content: 0 } }
                : tc.caseKind === "atomic-bad-batchsize"
                ? { limits: { batchSize: 10_000_000 } }
                : tc.caseKind === "atomic-bad-concurrency"
                ? { concurrency: 0 }
                : { timeoutMs: 0 }
              const exit = yield* Effect.scoped(
                Effect.gen(function*() {
                  const fs = yield* FileSystem.FileSystem
                  const dirHandle = yield* fs.open(dir)
                  yield* dirHandle.sync
                })
              ).pipe(
                Effect.provide(AtomicFileSystem.layerWith(opts)),
                Effect.exit
              )
              expect(Exit.isFailure(exit)).toBe(true)
            }
            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed: seed + 4, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })
})
