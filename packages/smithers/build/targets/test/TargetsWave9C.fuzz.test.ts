import { Flow, FlowRuntime } from "@smthrs/flow"
import { Model, ModelEvent } from "@smthrs/model"
import { Effect, Exit, Latch, Layer, PlatformError, Stream } from "effect"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Net from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as ExecSandbox from "../src/ExecSandbox.ts"
import * as Input from "../src/Input.ts"
import * as ProcessRef from "../src/internal/Process.ts"
import * as SandboxHost from "../src/internal/SandboxHost.ts"
import * as JevLint from "../src/JevLint.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as Secret from "../src/Secret.ts"
import * as SecretProxy from "../src/SecretProxy.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

const rawSocketRequest = (port: number, raw: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const sock = Net.connect({ host: "127.0.0.1", port }, () => {
      sock.write(raw)
    })
    const chunks: Array<Buffer> = []
    sock.on("data", (c) => chunks.push(typeof c === "string" ? Buffer.from(c) : c))
    sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    sock.on("error", reject)
    setTimeout(() => {
      sock.destroy()
      resolve(Buffer.concat(chunks).toString("utf8"))
    }, 3000)
  })

const httpRequest = (
  url: string,
  options: {
    readonly method?: string
    readonly headers?: Record<string, string>
    readonly body?: string
    readonly proxyPort?: number
  } = {}
): Promise<{ readonly status: number; readonly headers: Http.IncomingHttpHeaders; readonly body: string }> =>
  new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = Http.request(
      options.proxyPort !== undefined
        ? {
          host: "127.0.0.1",
          port: options.proxyPort,
          method: options.method ?? "GET",
          path: url,
          headers: { host: parsed.host, ...(options.headers ?? {}) }
        }
        : {
          host: parsed.hostname,
          port: Number(parsed.port),
          method: options.method ?? "GET",
          path: `${parsed.pathname}${parsed.search}`,
          headers: options.headers
        },
      (res) => {
        const chunks: Array<Buffer> = []
        res.on("data", (c) => chunks.push(typeof c === "string" ? Buffer.from(c) : c))
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          }))
      }
    )
    req.on("error", reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })

const makeTransport = (respond: (call: number) => string): LlmLint.ReviewTransport => {
  let count = 0
  return (seat) => {
    const text = respond(++count)
    return Effect.succeed({
      modelId: `resolved/${seat.model}`,
      model: Model.make({
        stream: () =>
          Stream.fromIterable([
            ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text }),
            ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
          ])
      })
    })
  }
}

const makeHost = (
  platform: NodeJS.Platform,
  overrides: {
    readonly bwrap?: string | undefined
    readonly sandboxExec?: string | undefined
    readonly docker?: string | undefined
  } = {}
): ExecSandbox.Host => ({
  platform,
  executable: (name: string) => {
    if (name === "bwrap") return overrides.bwrap
    if (name === "sandbox-exec") return overrides.sandboxExec
    if (name === "docker") return overrides.docker
    return undefined
  },
  exists: () => true,
  isDirectory: () => true,
  uid: 1000,
  gid: 1000
})

describe("@smthrs/targets Wave-9C: SecretProxy, SecretProxyResponse, Exec, ExecSandbox, JevLint & LlmLint deep fuzz", () => {
  it(
    "SecretProxy & SecretProxyResponse: vault validation, 413, 502 redaction, encoded/oversize upstream, CONNECT 400/501 & brokered origins",
    async () => {
      // parseConnectAuthority invalid IPv6 (line 138)
      expect(SecretProxy.parseConnectAuthority("[::1]bad")).toBeUndefined()
      expect(SecretProxy.parseConnectAuthority("[not-ipv6]:443")).toBeUndefined()
      expect(SecretProxy.parseConnectAuthority("[]:443")).toBeUndefined()

      // makeVault invalid options (lines 269, 274, 278)
      expect(() => SecretProxy.makeVault({ [Symbol("s")]: 1 } as never)).toThrow(/plain string-keyed/)
      const nonEnum = {}
      Object.defineProperty(nonEnum, "read", { value: () => "x", enumerable: false })
      expect(() => SecretProxy.makeVault(nonEnum as never)).toThrow(/enumerable/)
      expect(() => SecretProxy.makeVault({ read: "nope" as never })).toThrow(/function/)

      // Start real upstream HTTP server covering normal, gzip-encoded, oversize Content-Length, and abrupt drop
      const upstream = Http.createServer((req, res) => {
        if (req.url === "/gzip") {
          res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" })
          res.end("not-really-gzip")
          return
        }
        if (req.url === "/too-big") {
          res.writeHead(200, { "content-type": "application/octet-stream" })
          const chunk = Buffer.alloc(1024 * 1024, 65)
          for (let i = 0; i < 18; i++) {
            if (res.destroyed) break
            res.write(chunk)
          }
          res.end()
          return
        }
        if (req.url === "/drop") {
          req.socket.destroy()
          return
        }
        if (req.url === "/ok-cl") {
          const body = `echo:${req.headers["authorization"] ?? "none"}`
          res.writeHead(200, { "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)) })
          res.end(body)
          return
        }
        res.writeHead(200).end("ok")
      })
      await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
      const upAddr = upstream.address() as Net.AddressInfo
      const upOrigin = `http://127.0.0.1:${upAddr.port}`

      const vault = SecretProxy.makeVault({
        read: (name) => (name === "API_TOK" ? "super-secret-value-xyz" : undefined)
      })
      const sec = Secret.Secret("API_TOK")
      const httpCred = Secret.HttpSecret(sec, [upOrigin])
      const placeholder = vault.mint(httpCred)
      const proxy = await SecretProxy.startProxy(vault)

      try {
        const portNum = Number(new URL(proxy.endpoint).port)

        // 1. Declared Content-Length > maximumRequestBodyBytes -> 413 (lines 534-536)
        const r413 = await rawSocketRequest(
          portNum,
          `POST ${upOrigin}/ok-cl HTTP/1.1\r\nHost: 127.0.0.1:${upAddr.port}\r\nContent-Length: ${
            SecretProxy.maximumRequestBodyBytes + 5
          }\r\nConnection: close\r\n\r\n`
        )
        expect(r413).toContain("413")

        // 2. Upstream returns Content-Encoding: gzip -> 502 encoded response (SecretProxyResponse lines 48-49)
        const rGzip = await httpRequest(`${upOrigin}/gzip`, {
          proxyPort: portNum,
          headers: { authorization: `Bearer ${placeholder}` }
        })
        expect(rGzip.status).toBe(502)
        expect(rGzip.body).toContain("encoded")

        // 3. Upstream returns Content-Length > max -> 502 too large (SecretProxyResponse lines 56-57)
        const rBig = await httpRequest(`${upOrigin}/too-big`, {
          proxyPort: portNum,
          headers: { authorization: `Bearer ${placeholder}` }
        })
        expect(rBig.status).toBe(502)
        expect(rBig.body).toContain("too large")

        // 4. Upstream drops connection -> 502 redacted (lines 603-613)
        const rDrop = await httpRequest(`${upOrigin}/drop`, {
          proxyPort: portNum,
          headers: { authorization: `Bearer ${placeholder}` }
        })
        expect(rDrop.status).toBe(502)
        expect(rDrop.body).not.toContain("super-secret-value-xyz")

        // 5. Upstream normal response with Content-Length forwarded & secret redacted (SecretProxyResponse lines 80-81)
        const rOk = await httpRequest(`${upOrigin}/ok-cl`, {
          proxyPort: portNum,
          headers: { authorization: `Bearer ${placeholder}` }
        })
        expect(rOk.status).toBe(200)
        expect(rOk.body).not.toContain("super-secret-value-xyz")

        // 6. Brokered origin: valid forward, unknown audience, invalid URL (lines 807-810, 887, 892)
        await expect(proxy.originFor("not a url")).rejects.toThrow()
        await expect(proxy.originFor("http://127.0.0.1:1")).rejects.toThrow(/no declared secret/)
        const brokerUrl = await proxy.originFor(upOrigin)
        const brokerOk = await httpRequest(`${brokerUrl}/ok-cl`, {
          headers: { authorization: `Bearer ${placeholder}` }
        })
        expect(brokerOk.status).toBe(200)

        // 7. CONNECT bad authority -> 400 (lines 826-827) & CONNECT to declared secret audience via localhost loopback -> 501 (lines 662, 683, 831-837)
        const cBad = await rawSocketRequest(portNum, "CONNECT not-valid-authority HTTP/1.1\r\nHost: bad\r\n\r\n")
        expect(cBad).toContain("400 Bad Request")
        const cRefused = await rawSocketRequest(
          portNum,
          `CONNECT localhost:${upAddr.port} HTTP/1.1\r\nHost: localhost:${upAddr.port}\r\n\r\n`
        )
        expect(cRefused).toContain("501 Not Implemented")
      } finally {
        await proxy.close()
        upstream.closeAllConnections()
        await new Promise<void>((r) => upstream.close(() => r()))
      }
    },
    60_000
  )

  it(
    "Exec & ExecSandbox: docker confinement cleanup, secrets/network refusals, privateLinks, signal exit, Process faults & ExecSandbox unenforceable matrix",
    async () => {
      await withTempDir("wave9c-exec-", async (outer) => {
        const root = NodePath.join(outer, "ws")
        const binDir = NodePath.join(outer, "bin")
        await Fs.mkdir(root, { recursive: true })
        await Fs.mkdir(binDir, { recursive: true })
        const fakeDockerOk = NodePath.join(binDir, "docker-ok")
        const fakeDockerNoSuch = NodePath.join(binDir, "docker-nosuch")
        const fakeDockerFailRm = NodePath.join(binDir, "docker-failrm")
        const makeScript = async (p: string, body: string) => {
          await Fs.writeFile(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
        }
        await makeScript(fakeDockerOk, "if [ \"$1\" = \"rm\" ]; then exit 0; fi; echo \"docker-run-ok\"; exit 0")
        await makeScript(
          fakeDockerNoSuch,
          "if [ \"$1\" = \"rm\" ]; then echo \"Error response from daemon: No such container: $3\" >&2; exit 1; fi; echo \"ok\"; exit 0"
        )
        await makeScript(
          fakeDockerFailRm,
          "if [ \"$1\" = \"rm\" ]; then echo \"daemon busy\" >&2; exit 1; fi; echo \"ok\"; exit 0"
        )

        const baseExec = {
          cwd: ".",
          env: {} as Record<string, string>,
          secrets: [] as ReadonlyArray<Secret.HttpCredential>,
          expectedExitCodes: [0] as ReadonlyArray<number>,
          timeoutMs: 15_000
        }

        // 1. Docker confinement cleanup: exit 0, "No such container", and 3-attempt failure warning (lines 1863-1866, 1914-1949)
        for (const exe of [fakeDockerOk, fakeDockerNoSuch, fakeDockerFailRm]) {
          const res = await Effect.runPromise(
            Exec.run(
              {
                workspaceRoot: root,
                sandbox: {
                  policy: { network: false },
                  mechanism: WorkspaceDeclaration.Sandbox.Docker({ image: "alpine:3.20" }),
                  reads: [],
                  writes: [],
                  privateLinks: [{ path: "priv/a", target: "target-a" }]
                }
              },
              { ...baseExec, argv: ["echo", "hello"] }
            ).pipe(Effect.provideService(SandboxHost.SandboxHost, makeHost("linux", { docker: exe })))
          )
          expect(res.exitCode).toBe(0)
        }

        // 2. Docker + secrets refusal (lines 1735-1736)
        const sec = Secret.Secret("DOCKER_SEC", { fallback: "val123" })
        const httpSec = Secret.HttpSecret(sec, ["https://api.example.com"])
        const dockerSecExit = await Effect.runPromiseExit(
          Exec.run(
            {
              workspaceRoot: root,
              sandbox: {
                policy: { network: "loopback" },
                mechanism: WorkspaceDeclaration.Sandbox.Docker({ image: "alpine:3.20" }),
                reads: [],
                writes: []
              }
            },
            { ...baseExec, argv: ["echo", "hi"], secrets: [httpSec] }
          ).pipe(Effect.provideService(SandboxHost.SandboxHost, makeHost("linux", { docker: fakeDockerOk })))
        )
        expect(Exit.isFailure(dockerSecExit)).toBe(true)

        // 3. network: false + secrets refusal (lines 1750-1751)
        const netNoneSecExit = await Effect.runPromiseExit(
          Exec.run(
            {
              workspaceRoot: root,
              sandbox: { policy: { network: false }, reads: [], writes: [] }
            },
            { ...baseExec, argv: ["echo", "hi"], secrets: [httpSec] }
          )
        )
        expect(Exit.isFailure(netNoneSecExit)).toBe(true)

        // 4. toolEnvironment with base + sensitiveEnv dedup + argv/env size limits + win32 spawnShape
        const baseEnv = Exec.toolEnvironment(
          { EXTRA: "2" },
          ["DUP_KEY", "DUP_KEY"],
          {},
          { path: "/usr/bin", variables: { CUSTOM_BASE: "1" } }
        )
        expect(baseEnv["CUSTOM_BASE"]).toBe("1")
        expect(baseEnv["PATH"]).toBe("/usr/bin")

        const bigArgvExit = await Effect.runPromiseExit(
          Exec.run({ workspaceRoot: root }, { ...baseExec, argv: ["echo", "a".repeat(2_000_000)] })
        )
        expect(Exit.isFailure(bigArgvExit)).toBe(true)

        const bigEnvExit = await Effect.runPromiseExit(
          Exec.run({ workspaceRoot: root }, { ...baseExec, argv: ["echo", "ok"], env: { HUGE: "b".repeat(2_000_000) } })
        )
        expect(Exit.isFailure(bigEnvExit)).toBe(true)

        // win32 spawnShape for non-cmd .exe (line 1196)
        const fakeExe = NodePath.join(binDir, "tool.exe")
        await Fs.writeFile(fakeExe, "MZ", { mode: 0o755 })
        const shape = Exec.spawnShape([fakeExe, "arg1"], {
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".EXE;.CMD" }
        })
        expect(shape.windowsVerbatimArguments).toBe(false)

        // 5. Subprocess terminated by signal (line 1466)
        const sigExit = await Effect.runPromiseExit(
          Exec.run({ workspaceRoot: root }, { ...baseExec, argv: ["/bin/sh", "-c", "kill -TERM $$"] })
        )
        expect(Exit.isFailure(sigExit)).toBe(true)

        // 6. Custom Process service: startup retry exhaustion (lines 1387-1388), stream_failed (1439, 1449), teardownTimedOut + onStderr (1493-1501)
        const busyErr = PlatformError.systemError({
          _tag: "TimedOut",
          module: "Command",
          method: "spawn",
          description: "supervisor timed out"
        })
        const retryExhaustExit = await Effect.runPromiseExit(
          Exec.run({ workspaceRoot: root }, { ...baseExec, argv: ["echo", "hi"] }).pipe(
            Effect.provideService(Exec.StartupRetry, { attemptsMs: [5, 5], backoffMs: 1 }),
            Effect.provideService(ProcessRef.Process, {
              spawn: () => Effect.fail(busyErr),
              status: () => Effect.succeed({ code: 0, signal: null })
            })
          )
        )
        expect(Exit.isFailure(retryExhaustExit)).toBe(true)

        const streamFailExit = await Effect.runPromiseExit(
          Exec.run({ workspaceRoot: root }, { ...baseExec, argv: ["echo", "hi"] }).pipe(
            Effect.provideService(ProcessRef.Process, {
              spawn: () =>
                Effect.succeed({
                  pid: 12345,
                  stdout: Stream.fail(busyErr),
                  stderr: Stream.empty
                } as never),
              status: () => Effect.fail(busyErr)
            })
          )
        )
        expect(Exit.isFailure(streamFailExit)).toBe(true)

        // teardownTimedOut with onStderr callback (lines 433, 1493-1501)
        let stderrNote = ""
        const teardownDefect = PlatformError.systemError({
          _tag: "TimedOut",
          module: "Command",
          method: "kill",
          description: "teardown timed out",
          cause: Object.assign(new Error("timeout"), { code: "supervisor_timeout" })
        })
        const teardownRes = await Effect.runPromise(
          Exec.run(
            {
              workspaceRoot: root,
              onStderr: (chunk) => {
                stderrNote += new TextDecoder().decode(chunk)
              }
            },
            { ...baseExec, argv: ["echo", "ok"] }
          ).pipe(
            Effect.provideService(ProcessRef.Process, {
              spawn: () =>
                Effect.acquireRelease(
                  Effect.succeed({
                    pid: 12346,
                    stdout: Stream.succeed(new TextEncoder().encode("done\n")),
                    stderr: Stream.empty
                  } as never),
                  () => Effect.die(teardownDefect)
                ),
              status: () => Effect.succeed({ code: 0, signal: null })
            })
          )
        )
        expect(teardownRes.exitCode).toBe(0)
        expect(stderrNote).toContain("exited with status 0")

        // 7. ExecSandbox unenforceable matrix (lines 319, 331, 348, 356, 366) & ExecSandbox.protect (lines 425-431)
        expect(ExecSandbox.select({ policy: { network: false }, reads: [], writes: [] }, makeHost("linux"))._tag).toBe(
          "@smthrs/platform-node/SandboxUnenforceable"
        )
        expect(ExecSandbox.select({ policy: { network: false }, reads: [], writes: [] }, makeHost("darwin"))._tag).toBe(
          "@smthrs/platform-node/SandboxUnenforceable"
        )
        expect(ExecSandbox.select({ policy: { network: false }, reads: [], writes: [] }, makeHost("win32"))._tag).toBe(
          "@smthrs/platform-node/SandboxUnenforceable"
        )
        expect(
          ExecSandbox.select(
            { policy: { network: true }, reads: [], writes: [] },
            makeHost("linux", { docker: "/usr/bin/docker" })
          )._tag
        ).toBe("@smthrs/platform-node/SandboxUnenforceable")
        const bwrapHost = makeHost("linux", { bwrap: "/usr/bin/bwrap" })
        expect(
          ExecSandbox.protect({ policy: "none", reads: [], writes: [], writeProtected: ["src/a.ts"] }, root, [
            "echo",
            "hi"
          ], bwrapHost)
        ).toBeDefined()
        expect(
          ExecSandbox.protect(
            { policy: "none", reads: [], writes: [], writeProtected: [] },
            root,
            ["echo", "hi"],
            bwrapHost
          )
        ).toEqual(["echo", "hi"])
      })
    },
    60_000
  )

  it(
    "LlmLint & JevLint deep paths: credential masking overflow, ByteCapture growth, timeout, EPIPE, security verify, budget/legacy & JevReviewLive",
    async () => {
      await withTempDir("wave9c-llm-", async (root) => {
        const basePayload: LlmLint.Payload = {
          base: "HEAD",
          include: [Input.glob("**/*.ts")],
          context: [],
          prompt: "Review for defects.",
          rubric: "",
          engine: "claude",
          model: "claude-sonnet-4-5",
          batchSize: 10,
          contextTokens: 32_768,
          failOn: "error",
          required: false,
          scope: "all"
        }

        // 1. securityChecks missing "general" (line 2830)
        const badChecksExit = await Effect.runPromiseExit(
          LlmLint.review(
            { workspaceRoot: root, snapshot: [] },
            { ...basePayload, securityChecks: ["auth"] }
          )
        )
        expect(Exit.isFailure(badChecksExit)).toBe(true)

        // 2. Empty snapshot with required: false (line 2897)
        const emptyReport = await Effect.runPromise(
          LlmLint.review(
            { workspaceRoot: root, snapshot: [] },
            { ...basePayload, required: false, securityChecks: ["general"] }
          )
        )
        expect(emptyReport.files).toEqual([])
        expect(emptyReport.attempts).toEqual([])

        // 3. Context with 0 matched files (line 2904)
        const noCtxExit = await Effect.runPromiseExit(
          LlmLint.review(
            { workspaceRoot: root, snapshot: [{ path: "src/a.ts", contents: "export const a = 1\n", changed: true }] },
            { ...basePayload, context: [Input.glob("docs/missing.md")] }
          )
        )
        expect(Exit.isFailure(noCtxExit)).toBe(true)

        // 4. Snapshot too many files (line 2852)
        const tooManySnap = Array.from(
          { length: LlmLint.maximumReviewFiles + LlmLint.maximumContextFiles + 2 },
          (_, i) => ({
            path: `f${i}.ts`,
            contents: "x",
            changed: true
          })
        )
        const tooManyExit = await Effect.runPromiseExit(
          LlmLint.review({ workspaceRoot: root, snapshot: tooManySnap }, basePayload)
        )
        expect(Exit.isFailure(tooManyExit)).toBe(true)

        // 5. Credential masking: quoted w/ escape, unquoted w/ delimiter, JSON escape \\ & \/, relations edges, emitted mask.locations findings (lines 1034-1041, 1131-1163, 1286, 2952-2953, 3265)
        const credSource = [
          "const tok1 = \"ghp_1234567890abcdef1234567890abcdef1234\\\\end\"",
          "const tok2 = sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH;",
          "const esc = \"https:\\/\\/api.example.com\\\\path\""
        ].join("\n")
        const credExit = await Effect.runPromiseExit(
          LlmLint.review(
            {
              workspaceRoot: root,
              snapshot: [
                {
                  path: "src/a.ts",
                  contents: `import { b } from "./b.ts"\n${credSource}\nexport const v = b\n`,
                  changed: true
                },
                { path: "src/b.ts", contents: "export const b = 42\n", changed: true }
              ],
              transport: makeTransport(() => JSON.stringify({ findings: [] }))
            },
            basePayload
          )
        )
        // Emitted credential findings trigger FindingsError on failOn: "error" (covering mask.locations push at line 3265!)
        expect(Exit.isFailure(credExit)).toBe(true)

        // 6. Mask overflow (too many credential discoveries -> lines 1190-1191, 2940)
        const manyCreds = Array.from({ length: 10_050 }, (_, i) => `const k${i} = "ghp_${String(i).padStart(36, "a")}"`)
          .join("\n")
        const overflowExit = await Effect.runPromiseExit(
          LlmLint.review(
            {
              workspaceRoot: root,
              snapshot: [{ path: "src/creds.ts", contents: manyCreds, changed: true }],
              transport: makeTransport(() => "{\"findings\":[]}")
            },
            basePayload
          )
        )
        expect(Exit.isFailure(overflowExit)).toBe(true)

        // 7. Context window too small for huge instructions (line 2979)
        const tinyWinExit = await Effect.runPromiseExit(
          LlmLint.review(
            {
              workspaceRoot: root,
              snapshot: [{ path: "src/a.ts", contents: "export const x = 1\n", changed: true }],
              transport: makeTransport(() => "{\"findings\":[]}")
            },
            { ...basePayload, prompt: "p".repeat(150_000), contextTokens: 32_768 }
          )
        )
        expect(Exit.isFailure(tinyWinExit)).toBe(true)

        // 8. plan.length > maximumReviewBatches without store (line 3000) & with store hitting remaining > 0 (lines 3176-3177, 3241-3244)
        const manyFiles = Array.from({ length: LlmLint.maximumReviewBatches + 2 }, (_, i) => ({
          path: `src/f${i}.ts`,
          contents: `export const x${i} = ${i}\n`,
          changed: true
        }))
        const tooManyBatchesNoStore = await Effect.runPromiseExit(
          LlmLint.review(
            {
              workspaceRoot: root,
              snapshot: manyFiles,
              transport: makeTransport(() => "{\"findings\":[]}")
            },
            { ...basePayload, batchSize: 1 }
          )
        )
        expect(Exit.isFailure(tooManyBatchesNoStore)).toBe(true)

        const storeDir = NodePath.join(root, "finding-store")
        const tooManyBatchesStore = await Effect.runPromiseExit(
          LlmLint.review(
            {
              workspaceRoot: root,
              snapshot: manyFiles,
              store: { directory: storeDir },
              transport: makeTransport(() => "{\"findings\":[]}")
            },
            { ...basePayload, batchSize: 1 }
          )
        )
        expect(Exit.isFailure(tooManyBatchesStore)).toBe(true)

        // 9. Security multi-pass with verify pass (lines 2766, 2781-2782)
        const secReport = await Effect.runPromise(
          LlmLint.review(
            {
              workspaceRoot: root,
              snapshot: [{
                path: "src/auth.ts",
                contents: "export function login(u: string) { return u }\n",
                changed: true
              }],
              transport: makeTransport((call) =>
                JSON.stringify({
                  status: "completed",
                  coverage: [{ checkId: "general", status: "completed", evidence: "inspected src/auth.ts" }],
                  missingContext: [],
                  findings: [{
                    file: "src/auth.ts",
                    line: 1,
                    severity: "warning",
                    message: call === 1 ? "missing auth check" : "verified missing auth check",
                    security: {
                      checkId: "general",
                      impact: "medium",
                      verification: call === 1 ? "suspected" : "confirmed",
                      releaseRecommendation: "review",
                      attackerPreconditions: "unauthenticated caller",
                      evidence: `pass ${call}`,
                      nextConfirmationStep: "add integration test"
                    }
                  }]
                })
              )
            },
            { ...basePayload, securityChecks: ["general"], alternateModel: "claude-opus-5-5", failOn: "error" }
          )
        )
        expect(secReport.findings.length).toBeGreaterThanOrEqual(1)

        // 10. Real subprocess fake CLI: ByteCapture growth (>64KB stdout), EPIPE on stdin, timeout (ETIMEDOUT)
        const binDir = NodePath.join(root, "fake-cli")
        await Fs.mkdir(binDir, { recursive: true })
        const bigStdoutCli = NodePath.join(binDir, "big-claude")
        await Fs.writeFile(
          bigStdoutCli,
          `#!/bin/sh\nnode -e 'const findings = Array.from({ length: 10 }, (_, i) => ({ file: "src/a.ts", line: 1, severity: "info", message: "m".repeat(7000) + i })); console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(findings) }))'\n`,
          { mode: 0o755 }
        )
        const bigOutReport = await Effect.runPromise(
          LlmLint.review(
            {
              workspaceRoot: root,
              snapshot: [{ path: "src/a.ts", contents: "export const a = 1\n", changed: true }],
              executable: bigStdoutCli
            },
            basePayload
          )
        )
        expect(bigOutReport.findings.length).toBe(10)

        // EPIPE on stdin (cli exits immediately without reading large stdin)
        const epipeCli = NodePath.join(binDir, "epipe-claude")
        await Fs.writeFile(
          epipeCli,
          "#!/bin/sh\necho \"{\\\"type\\\":\\\"result\\\",\\\"subtype\\\":\\\"success\\\",\\\"is_error\\\":false,\\\"result\\\":\\\"[]\\\"}\"\nexit 0\n",
          { mode: 0o755 }
        )
        const epipeReport = await Effect.runPromise(
          LlmLint.review(
            {
              workspaceRoot: root,
              snapshot: [{ path: "src/a.ts", contents: "const x = 1\n".repeat(4000), changed: true }],
              executable: epipeCli
            },
            basePayload
          )
        )
        expect(epipeReport.findings).toEqual([])

        // Subprocess timeout (ETIMEDOUT, line 1411)
        const slowCli = NodePath.join(binDir, "slow-claude")
        await Fs.writeFile(slowCli, "#!/bin/sh\nsleep 5\n", { mode: 0o755 })
        const timeoutExit = await Effect.runPromiseExit(
          LlmLint.review(
            {
              workspaceRoot: root,
              snapshot: [{ path: "src/a.ts", contents: "export const a = 1\n", changed: true }],
              executable: slowCli,
              timeoutMs: 150
            },
            basePayload
          )
        )
        expect(Exit.isFailure(timeoutExit)).toBe(true)

        // 11. JevLint: missing env key & JevReviewLive layer (lines 295-300, 459, 472, 509)
        await Fs.mkdir(NodePath.join(root, "jev-src"), { recursive: true })
        await Fs.writeFile(NodePath.join(root, "jev-src", "a.ts"), "export const a = 1\n")
        const jevPayload: JevLint.Payload = {
          rules: [{
            id: "r1",
            lookFor: "clean code",
            violation: "dirty code",
            compliant: "clean code",
            files: [Input.glob("jev-src/**/*.ts")],
            severity: "error"
          }],
          threshold: 0.8,
          failOn: "error",
          model: "anthropic/claude-sonnet-4-5"
        }
        const savedKey = process.env[JevLint.keyVariable]
        try {
          delete process.env[JevLint.keyVariable]
          const noKeyExit = await Effect.runPromiseExit(
            JevLint.review({ workspaceRoot: root }, jevPayload)
          )
          expect(Exit.isFailure(noKeyExit)).toBe(true)
        } finally {
          if (savedKey !== undefined) process.env[JevLint.keyVariable] = savedKey
        }

        // JevReviewLive layer registration with empty matching glob
        let regJev: ((p: JevLint.Payload, id: string) => Effect.Effect<LlmLint.Report, JevLint.ReviewError>) | undefined
        const runtime = FlowRuntime.FlowRuntime.of(
          {
            register: (_flow: unknown, exec: typeof regJev) =>
              Effect.sync(() => {
                regJev = exec
              }),
            actionExecute: (action: { readonly execute: Effect.Effect<unknown, unknown> }) =>
              Effect.map(Effect.exit(action.execute), (exit) => new Flow.Complete({ exit }))
          } as unknown as FlowRuntime.FlowRuntime["Service"]
        )
        const jevLayerExit = await Effect.runPromiseExit(
          Effect.gen(function*() {
            yield* Layer.build(
              JevLint.JevReviewLive({ workspaceRoot: root }).pipe(
                Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, runtime))
              )
            )
            const instance = FlowRuntime.FlowInstance.of({
              executionId: "jev-wave9c",
              actionState: { count: 0, latch: Latch.makeUnsafe() }
            } as never)
            return yield* regJev!(
              {
                ...jevPayload,
                rules: [{ ...jevPayload.rules[0]!, files: [Input.glob("no-match-dir/**/*.ts", { allowEmpty: true })] }]
              },
              "jev-wave9c"
            ).pipe(
              Effect.provideService(FlowRuntime.FlowInstance, instance),
              Effect.provideService(FlowRuntime.FlowRuntime, runtime)
            )
          }).pipe(Effect.scoped)
        )
        expect(Exit.isFailure(jevLayerExit)).toBe(true)
      })
    },
    120_000
  )
})
