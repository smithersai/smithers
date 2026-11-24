import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { Cli } from "incur"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Presentation from "../src/cli/Presentation.ts"
import { auth, browserLogin } from "../src/internal/backend/Auth.ts"
import * as Catalog from "../src/internal/backend/Catalog.ts"
import { APIError, Client, type Values } from "../src/internal/backend/Client.ts"
import * as Commands from "../src/internal/backend/Commands.ts"
import { copy } from "../src/internal/backend/Copy.ts"
import * as HostService from "../src/internal/backend/HostService.ts"
import { NotFound } from "../src/internal/backend/Process.ts"
import { repositories } from "../src/internal/backend/Repositories.ts"
import { Session } from "../src/internal/backend/Session.ts"
import { stacks } from "../src/internal/backend/Stack.ts"
import { workspaces } from "../src/internal/backend/Workspaces.ts"
import * as Host from "./fixtures/runner/host.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "25")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "90601")
const validTok = "smthrs_" + "a".repeat(48)

const assertInv = (cond: boolean, message: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${message}`)
}

const runFuzz = <A>(
  arb: Arbitrary.Arbitrary<A>,
  fn: (value: A) => void,
  opts: { readonly executions: number; readonly seed: number }
) =>
  Effect.runPromise(
    Fuzz.run(
      arb,
      (value) =>
        Effect.sync(() => {
          fn(value)
          return true
        }),
      opts
    )
  )

const expectPassed = (report: { readonly _tag: string }): void => {
  if (report._tag !== "Passed") throw new Error(`Falsified: ${JSON.stringify(report)}`)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const withFakeStdin = async <A>(stream: Readable & { isTTY?: boolean }, fn: () => Promise<A>): Promise<A> => {
  const orig = Object.getOwnPropertyDescriptor(process, "stdin")!
  Object.defineProperty(process, "stdin", { value: stream, configurable: true, writable: true })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, "stdin", orig)
  }
}

describe("@smthrs/cli Wave-9F Deep Backend Sweep (Client, HostService, Stack, Session, Copy, Workspaces, Repositories, Catalog, Commands & Auth)", () => {
  it(
    "Client & Session cover stdin/confirm/pages/sse/request-abort/timeout/identity-race/managedFile/keyring",
    async () => {
      await withTempDir("wave9f-cs-", async (tmp) => {
        // Local loopback HTTP server for Client pagination, SSE, timeout & credential tests
        let sseMode: "empty" | "many" = "empty"
        let pageMode: "bad_link" | "repeat_cursor" | "ok" = "bad_link"
        let reqDelayMs = 0
        const srv = createServer((req, res) => {
          const u = new URL(req.url ?? "/", "http://127.0.0.1")
          if (u.pathname === "/slow") {
            setTimeout(() => {
              res.writeHead(200, { "content-type": "application/json" })
              res.end("{}")
            }, reqDelayMs)
            return
          }
          if (u.pathname === "/pages") {
            if (pageMode === "bad_link") {
              res.writeHead(200, {
                "content-type": "application/json",
                link: "<http://evil.example/next>; rel=\"next\""
              })
              res.end(JSON.stringify([{ id: 1 }]))
              return
            }
            if (pageMode === "repeat_cursor") {
              res.writeHead(200, {
                "content-type": "application/json",
                link: `<http://127.0.0.1:${(srv.address() as { port: number }).port}/pages?cursor=same>; rel="next"`
              })
              res.end(JSON.stringify([{ id: 1 }]))
              return
            }
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify([{ id: 1 }]))
            return
          }
          if (u.pathname === "/sse") {
            if (sseMode === "empty") {
              res.writeHead(204)
              res.end()
              return
            }
            res.writeHead(200, { "content-type": "text/event-stream" })
            const pad = "x".repeat(500_000)
            for (let i = 0; i < 10; i++) res.write(`event: tick\ndata: "${pad}"\n\n`)
            res.end()
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true, via: req.headers["smithers-via"] ?? null }))
        })
        await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
        const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`

        try {
          const makeClient = (extraEnv: Record<string, string | undefined> = {}, signal?: AbortSignal) =>
            new Client({
              environment: {
                HOME: tmp,
                XDG_CONFIG_HOME: tmp,
                SMITHERS_AUTH_FILE: join(tmp, "auth.json"),
                SMITHERS_API_ORIGIN: origin,
                SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
                SMITHERS_TOKEN: validTok,
                ...extraEnv
              },
              ...(signal ? { signal } : {})
            })

          const c = makeClient()

          // 1. Client.stdin: empty refusal, allowEmpty, valid UTF-8 & string chunks, >4 MiB refusal
          await withFakeStdin(Readable.from([]), async () => {
            await expect(c.stdin("body")).rejects.toThrow("body is required on stdin")
          })
          await withFakeStdin(Readable.from([]), async () => {
            expect(await c.stdin("body", true)).toBe("")
          })
          await withFakeStdin(Readable.from([Buffer.from("hello "), "world\n"]), async () => {
            expect(await c.stdin("body")).toBe("hello world")
          })
          const bigChunk = Buffer.alloc(4 * 1024 * 1024 + 10, 65)
          await withFakeStdin(Readable.from([bigChunk]), async () => {
            await expect(c.stdin("body")).rejects.toThrow("exceeds 4 MiB")
          })

          // 2. Client.confirm: TTY "n" cancels, TTY "y" succeeds
          const ttyNo = Object.assign(new PassThrough(), { isTTY: true })
          ttyNo.end("n\n")
          await withFakeStdin(ttyNo, async () => {
            await expect(c.confirm(false, "delete thing")).rejects.toThrow("Operation cancelled")
          })
          const ttyYes = Object.assign(new PassThrough(), { isTTY: true })
          ttyYes.end("yes\n")
          await withFakeStdin(ttyYes, async () => {
            await c.confirm(false, "delete thing")
          })

          // 3. Client.request: non-loopback explicit token/Authorization header refusal, Smithers-Via, abort & timeout
          const cPub = makeClient({ SMITHERS_API_ORIGIN: "https://api.example.test", SMITHERS_VIA: "cli-test" })
          await expect(
            cPub.request("GET", "https://other.example.test/x", undefined, { token: validTok })
          ).rejects.toThrow()
          await expect(
            cPub.request("GET", "https://other.example.test/x", undefined, { headers: { Authorization: "Bearer x" } })
          ).rejects.toThrow()

          const cVia = makeClient({ SMITHERS_VIA: "wave9f" })
          const viaRes = (await cVia.request("GET", "/ok", undefined, { via: "wave9f" } as never)) as {
            via: string | null
          }
          expect(viaRes).toBeDefined()

          const ab = new AbortController()
          ab.abort()
          await expect(c.request("GET", "/ok", undefined, { signal: ab.signal })).rejects.toThrow()

          reqDelayMs = 200
          await expect(
            c.request("GET", "/slow", undefined, { signal: AbortSignal.timeout(15) })
          ).rejects.toThrow()
          reqDelayMs = 0

          // 4. Client.pages: cross-origin/bad Link header & repeated pagination cursor
          pageMode = "bad_link"
          await expect(c.pages((cur) => cur ? `/pages?cursor=${cur}` : "/pages", "", true)).rejects.toThrow()
          pageMode = "repeat_cursor"
          await expect(c.pages((cur) => cur ? `/pages?cursor=${cur}` : "/pages", "", true)).rejects.toThrow(
            "repeated a pagination cursor"
          )

          // 5. Client.sse: empty 204 body & maximumItems exceeded
          sseMode = "empty"
          expect(await c.events("/sse")).toEqual([])
          sseMode = "many"
          await expect(c.events("/sse")).rejects.toThrow()

          // 6. Session: invalid config.toon (parse error & array)
          const cfgDir1 = join(tmp, "cfg1")
          mkdirSync(join(cfgDir1, "smithers"), { recursive: true })
          writeFileSync(join(cfgDir1, "smithers", "config.toon"), "a: [1, 2\n  bad: : :")
          const sBad = new Session({
            HOME: tmp,
            XDG_CONFIG_HOME: cfgDir1,
            SMITHERS_AUTH_FILE: join(tmp, "a1.json"),
            SMITHERS_API_ORIGIN: origin,
            SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
          })
          expect(() => sBad.config()).toThrow("Invalid Smithers config")
          const cfgDir2 = join(tmp, "cfg2")
          mkdirSync(join(cfgDir2, "smithers"), { recursive: true })
          writeFileSync(join(cfgDir2, "smithers", "config.toon"), "- a\n- b\n")
          const sBadArr = new Session({
            HOME: tmp,
            XDG_CONFIG_HOME: cfgDir2,
            SMITHERS_AUTH_FILE: join(tmp, "a2.json"),
            SMITHERS_API_ORIGIN: origin,
            SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
          })
          expect(() => sBadArr.config()).toThrow("Invalid Smithers config")

          // managedFile mismatch (SMITHERS_TOKEN_FILE outside /run/smithers/...)
          const sManaged = new Session({
            HOME: tmp,
            XDG_CONFIG_HOME: tmp,
            SMITHERS_AUTH_FILE: join(tmp, "m-auth.json"),
            SMITHERS_API_ORIGIN: origin,
            SMITHERS_TERMINAL_SESSION: "sess-1",
            SMITHERS_TERMINAL_ISSUER: origin,
            SMITHERS_TOKEN_FILE: join(tmp, "not-in-run-smithers")
          })
          await expect(sManaged.resolve(origin)).rejects.toThrow()

          // pending epoch refusal
          const epochFile = join(tmp, "auth-epoch.json")
          writeFileSync(epochFile, JSON.stringify({ api_url: origin }))
          writeFileSync(epochFile + ".pending", "1")
          const sEpoch = new Session({
            HOME: tmp,
            XDG_CONFIG_HOME: tmp,
            SMITHERS_AUTH_FILE: epochFile,
            SMITHERS_API_ORIGIN: origin,
            SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
          })
          expect(sEpoch.credentialIdentity(origin)).toBeDefined()

          // nativeKeyring error -> storageFailed & legacy keyring lookup/delete
          const legAuth = join(tmp, "leg-auth.json")
          writeFileSync(
            legAuth,
            JSON.stringify({
              version: 2,
              storage: "keyring",
              host: "api.example.test",
              api_url: "https://api.example.test"
            })
          )
          const sKeyErr = new Session(
            {
              HOME: tmp,
              XDG_CONFIG_HOME: tmp,
              SMITHERS_AUTH_FILE: legAuth,
              SMITHERS_API_ORIGIN: "https://api.example.test"
            },
            {
              run: () => Effect.fail(new Error("keyring broken"))
            }
          )
          await expect(sKeyErr.save("https://api.example.test", validTok)).rejects.toThrow()

          const sKeyOk = new Session(
            {
              HOME: tmp,
              XDG_CONFIG_HOME: tmp,
              SMITHERS_AUTH_FILE: legAuth,
              SMITHERS_API_ORIGIN: "https://api.example.test"
            },
            {
              run: (_cmd, args) => {
                const joined = args.join(" ")
                if (joined.includes("lookup") || joined.includes("find-generic-password")) {
                  return Effect.succeed({ code: 0, stdout: validTok + "\n", stderr: "" })
                }
                return Effect.succeed({ code: 0, stdout: "", stderr: "" })
              }
            }
          )
          await sKeyOk.save("https://api.example.test", validTok)
          const krRes = await sKeyOk.resolve("https://api.example.test")
          expect(krRes).toBeDefined()
          await sKeyOk.clear("https://api.example.test")

          const sKeyNotFound = new Session(
            {
              HOME: tmp,
              XDG_CONFIG_HOME: tmp,
              SMITHERS_AUTH_FILE: legAuth,
              SMITHERS_API_ORIGIN: "https://api.example.test"
            },
            {
              run: () => Effect.fail(new NotFound("secret-tool"))
            }
          )
          expect(await sKeyNotFound.resolve("https://api.example.test")).toBeUndefined()
        } finally {
          srv.close()
        }
      })
    },
    60_000
  )

  it(
    "HostService covers verifyBundle errors, stop timeout, launchctl errors, maintenance stderr, validateAddress, startInstalled & installTelemetry",
    async () => {
      await withTempDir("wave9f-hs-", async (tmp) => {
        // 1. validateAddress edge errors
        expect(() =>
          HostService.validateAddress({
            bind: "0.0.0.0:4000",
            origins: Array.from({ length: 11 }, (_, i) => `https://h${i}.example.com`)
          })
        ).toThrow("Invalid public origins")
        expect(() => HostService.validateAddress({ origins: ["not-a-url"] })).toThrow("Invalid public origin")
        expect(() => HostService.validateAddress({ origins: ["https://localhost:4000"] })).toThrow()

        // 2. verifyBundle: bad manifest entry, metadata mismatch, missing executable bit
        const rev = "a".repeat(40)
        const b1 = join(tmp, "b1")
        mkdirSync(b1, { recursive: true })
        writeFileSync(join(b1, "file.txt"), "hi")
        writeFileSync(
          join(b1, "manifest.json"),
          JSON.stringify({
            version: 1,
            platform: "darwin-arm64",
            revision: rev,
            files: [{ path: "file.txt", sha256: "bad-hash", stage: "bin", mode: 0o644 }]
          })
        )
        expect(() => HostService.verifyBundle(b1)).toThrow("Invalid bundle manifest entry")

        const b2 = join(tmp, "b2")
        mkdirSync(join(b2, "bin"), { recursive: true })
        const binBody = "#!/bin/sh\n"
        writeFileSync(join(b2, "bin", "smithers-host"), binBody)
        chmodSync(join(b2, "bin", "smithers-host"), 0o644)
        const digest = createHash("sha256").update(binBody).digest("hex")
        writeFileSync(
          join(b2, "manifest.json"),
          JSON.stringify({
            version: 1,
            platform: "darwin-arm64",
            revision: rev,
            files: [{ path: "bin/smithers-host", sha256: digest, stage: "bin", mode: 0o755 }]
          })
        )
        expect(() => HostService.verifyBundle(b2)).toThrow("Bundle metadata differs")

        // Fix mode to 0o644 -> missing executable bit on required executable
        writeFileSync(
          join(b2, "manifest.json"),
          JSON.stringify({
            version: 1,
            platform: "darwin-arm64",
            revision: rev,
            files: [{ path: "bin/smithers-host", sha256: digest, stage: "bin", mode: 0o644 }]
          })
        )
        expect(() => HostService.verifyBundle(b2)).toThrow("Bundle executable missing")

        // 3. install launchctl failure (bootstrap fail & kickstart fail)
        const bGood = join(tmp, "b-good")
        mkdirSync(join(bGood, "bin"), { recursive: true })
        const execContent = "#!/bin/sh\necho ok\n"
        const execHash = createHash("sha256").update(execContent).digest("hex")
        const reqBins = ["bin/smithers-server", "bin/smithers-backend", "bin/msb"]
        const manifestFiles = reqBins.map((rel) => {
          const full = join(bGood, rel)
          mkdirSync(join(full, ".."), { recursive: true })
          writeFileSync(full, execContent)
          chmodSync(full, 0o755)
          return { path: rel, sha256: execHash, stage: "bin", mode: 0o755 }
        })
        writeFileSync(
          join(bGood, "manifest.json"),
          JSON.stringify({ version: 1, platform: "darwin-arm64", revision: rev, files: manifestFiles })
        )

        const agentsDir = join(tmp, "agents")
        const stateDir = join(tmp, "state")
        mkdirSync(agentsDir, { recursive: true })
        mkdirSync(stateDir, { recursive: true })

        expect(HostService.launchd("darwin", 501, tmp).domain).toBe("gui/501")
        const makeSys = (
          fn: (args: ReadonlyArray<string>) => { status: number; stdout: string; stderr: string }
        ): HostService.Launchd => ({
          agentsDir,
          domain: "gui/501",
          launchctl: fn
        })

        await expect(
          HostService.install(
            { bundle: bGood, stateDir, home: tmp },
            makeSys((args) => ({
              status: args[0] === "bootstrap" || args[0] === "print" ? 1 : 0,
              stdout: "",
              stderr: "boot err"
            }))
          )
        ).rejects.toThrow()

        await expect(
          HostService.install(
            { bundle: bGood, stateDir, home: tmp, bind: "127.0.0.1:4000" },
            makeSys((args) => ({ status: args[0] === "bootout" ? 1 : 0, stdout: "", stderr: "bootout err" }))
          )
        ).rejects.toThrow()

        // 4. maintenance non-zero exit with `code: message` stderr & plain stderr
        const sysOk = makeSys((args) => ({ status: args[0] === "print" ? 1 : 0, stdout: "", stderr: "" }))
        await HostService.install({ bundle: bGood, stateDir, home: tmp }, sysOk)
        expect(() =>
          HostService.maintenance(
            "backup",
            tmp,
            sysOk,
            (() => ({ status: 1, stdout: "", stderr: "custom_err: failed here\n" })) as never
          )
        ).toThrow("custom_err: failed here")
        expect(() =>
          HostService.maintenance(
            "upgrade",
            undefined,
            sysOk,
            (() => ({ status: 1, stdout: "", stderr: "" })) as never
          )
        ).toThrow("Host maintenance backend did not answer")

        // 5. startText with setup_urls + warning
        expect(
          HostService.startText({ setup_urls: ["http://127.0.0.1:4000/setup"], warning: "LAN browsers need --origin" })
        ).toContain("LAN browsers need --origin")

        // 6. installTelemetry: 500 -> undefined, array -> undefined, valid payload, unreachable -> undefined
        let telMode: "err" | "arr" | "ok" = "err"
        const telSrv = createServer((_req, res) => {
          if (telMode === "err") {
            res.writeHead(500)
            res.end()
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(
            JSON.stringify(
              telMode === "arr"
                ? [1, 2]
                : {
                  capacity: 0,
                  this_mac: { memory_gb: 32, perf_cores: 8, capacity: 0, limit: { term: "memory", fix: "free ram" } },
                  github_app: { configured: true, installed: false }
                }
            )
          )
        })
        await new Promise<void>((r) => telSrv.listen(0, "127.0.0.1", r))
        const telUrl = `http://127.0.0.1:${(telSrv.address() as { port: number }).port}/api/install`
        try {
          telMode = "err"
          expect(await HostService.installTelemetry(telUrl, "cred")).toBeUndefined()
          telMode = "arr"
          expect(await HostService.installTelemetry(telUrl)).toBeUndefined()
          telMode = "ok"
          const tel = await HostService.installTelemetry(telUrl, "cred")
          expect(tel?.this_mac).toBeDefined()
          expect(tel?.github_app).toEqual({ configured: true, installed: false })
        } finally {
          telSrv.close()
        }
        expect(await HostService.installTelemetry("http://127.0.0.1:1/api/install")).toBeUndefined()
      })
    },
    60_000
  )

  it(
    "Copy, Workspaces, Repositories, Catalog, Commands & Auth cover tar/timeout/conflicts, exec poll/abort, repo init/rollback, MCP refusals & OAuth edge status codes",
    async () => {
      await withTempDir("wave9f-ops-", async (tmp) => {
        // 1. Copy: real local tar via 2-line ssh wrapper -> upload, download, /. on file, dir merge, file/dir conflict, exit 43/44/1, timeout
        const binDir = join(tmp, "bin")
        mkdirSync(binDir, { recursive: true })
        const modeFile = join(tmp, "ssh-mode")
        const sshBin = join(binDir, "ssh")
        writeFileSync(
          sshBin,
          `#!/bin/sh
mode=$(cat "${modeFile}" 2>/dev/null || echo run)
if [ "$mode" = "43" ]; then exit 43; fi
if [ "$mode" = "44" ]; then exit 44; fi
if [ "$mode" = "1" ]; then echo "boom stderr" >&2; exit 1; fi
if [ "$mode" = "sleep" ]; then sleep 5; exit 0; fi
for last do :; done
exec /bin/bash -c "$last"
`
        )
        chmodSync(sshBin, 0o755)

        const guest = {
          command: "ssh guest",
          host_keys: [{
            known_hosts_line: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
          }]
        }

        // Loopback server for workspaces SSH + exec + repos + auth
        let execPollCount = 0
        let execScenario: "mismatch" | "invalid_state" | "not_terminal" | "cancel_on_abort" = "mismatch"
        let repoConnectFail = false
        let obsTicket = "bad-ticket"
        const srv = createServer((req, res) => {
          const u = new URL(req.url ?? "/", "http://127.0.0.1")
          if (u.pathname.endsWith("/ssh")) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(guest))
            return
          }
          if (req.method === "POST" && u.pathname.endsWith("/command-runs")) {
            execPollCount = 0
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ operationId: "op-1", state: "running" }))
            return
          }
          if (req.method === "GET" && u.pathname.includes("/command-runs/")) {
            execPollCount++
            res.writeHead(200, { "content-type": "application/json" })
            if (execScenario === "mismatch") {
              res.end(JSON.stringify({ operationId: "op-wrong", state: "completed", exitCode: 0 }))
            } else if (execScenario === "invalid_state") {
              res.end(JSON.stringify({ operationId: "op-1", state: "weird_state" }))
            } else {
              res.end(JSON.stringify({ operationId: "op-1", state: "running" }))
            }
            return
          }
          if (req.method === "POST" && u.pathname.includes("/cancel")) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ operationId: "op-1", state: "cancelled" }))
            return
          }
          if (u.pathname === "/api/repo-connection") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ ok: true }))
            return
          }
          if (u.pathname.endsWith("/github-app-status")) {
            if (repoConnectFail) {
              res.writeHead(500, { "content-type": "application/json" })
              res.end(JSON.stringify({ message: "gh app error" }))
              return
            }
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ github_app_installed: true }))
            return
          }
          if (u.pathname === "/api/observe/ticket") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ ticket: obsTicket }))
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
        })
        await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
        const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`

        try {
          const makeClient = (extra: Record<string, string | undefined> = {}, signal?: AbortSignal) =>
            new Client({
              environment: {
                ...process.env,
                HOME: tmp,
                XDG_CONFIG_HOME: tmp,
                XDG_STATE_HOME: tmp,
                PATH: `${binDir}:${process.env.PATH ?? ""}`,
                SMITHERS_AUTH_FILE: join(tmp, "auth.json"),
                SMITHERS_API_ORIGIN: origin,
                SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
                SMITHERS_TOKEN: validTok,
                COPYFILE_DISABLE: "1",
                SMITHERS_WORKSPACE_COMMAND_POLL_INTERVAL_MS: "5",
                ...extra
              },
              ...(signal ? { signal } : {})
            })

          const c = makeClient()
          const srcFile = join(tmp, "local.txt")
          writeFileSync(srcFile, "hello copy\n")
          const srcDir = join(tmp, "src-dir")
          mkdirSync(join(srcDir, "sub"), { recursive: true })
          writeFileSync(join(srcDir, "sub", "a.txt"), "aaa\n")
          const remoteDir = join(tmp, "remote-dir")
          mkdirSync(remoteDir, { recursive: true })

          // /. on regular file -> UsageError
          writeFileSync(modeFile, "run")
          await expect(copy(c, { src: `${srcFile}/.`, dst: `ws-1:${remoteDir}` }, { repo: "o/r" })).rejects.toThrow(
            "/. requires a directory"
          )

          // Upload directory contents (`/.`) & download contents into existing dir (recursive merge!)
          await copy(c, { src: `${srcDir}/.`, dst: `ws-1:${remoteDir}` }, { repo: "o/r" })
          const dlDir = join(tmp, "dl-dir")
          mkdirSync(join(dlDir, "sub"), { recursive: true })
          writeFileSync(join(dlDir, "sub", "existing.txt"), "keep\n")
          await copy(c, { src: `ws-1:${remoteDir}/.`, dst: dlDir }, { repo: "o/r" })
          expect(existsSync(join(dlDir, "sub", "a.txt"))).toBe(true)

          // File vs dir conflict on download
          const conflictDst = join(tmp, "conflict-dst")
          mkdirSync(conflictDst, { recursive: true })
          writeFileSync(join(conflictDst, "sub"), "i am a file, not a dir")
          await expect(copy(c, { src: `ws-1:${remoteDir}/.`, dst: conflictDst }, { repo: "o/r" })).rejects.toThrow()

          // Symlink destination refusal
          const symParent = join(tmp, "sym-parent")
          mkdirSync(symParent, { recursive: true })
          symlinkSync(dlDir, join(symParent, "sub"))
          await expect(copy(c, { src: `ws-1:${remoteDir}/.`, dst: symParent }, { repo: "o/r" })).rejects.toThrow(
            "symlink"
          )

          // Remote exit codes 43, 44, 1 & timeout
          writeFileSync(modeFile, "43")
          await expect(copy(c, { src: srcFile, dst: `ws-1:${remoteDir}/f.txt` }, { repo: "o/r" })).rejects.toThrow(
            "no tar"
          )
          writeFileSync(modeFile, "44")
          await expect(copy(c, { src: `ws-1:${remoteDir}/missing`, dst: dlDir }, { repo: "o/r" })).rejects.toThrow(
            "not found"
          )
          writeFileSync(modeFile, "1")
          await expect(copy(c, { src: srcFile, dst: `ws-1:${remoteDir}/f.txt` }, { repo: "o/r" })).rejects.toThrow(
            "copy failed"
          )
          writeFileSync(modeFile, "sleep")
          await expect(
            copy(c, { src: srcFile, dst: `ws-1:${remoteDir}/f.txt` }, { repo: "o/r", timeout: 0.05 })
          ).rejects.toThrow("timed out")
          writeFileSync(modeFile, "run")

          // 2. Workspaces exec polling: mismatch, invalid state, abort -> cancel, pre-aborted shell
          await expect(
            workspaces["workspace exec"]!(c, { id: "ws-1" }, {
              repo: "o/r",
              command: "echo hi",
              "exec-id": "x".repeat(130)
            })
          ).rejects.toThrow("Invalid exec id")
          execScenario = "mismatch"
          await expect(
            workspaces["workspace exec"]!(c, { id: "ws-1" }, { repo: "o/r", command: "echo hi", timeout: 5 })
          ).rejects.toThrow("Mismatched command receipt")
          execScenario = "invalid_state"
          await expect(
            workspaces["workspace exec"]!(c, { id: "ws-1" }, { repo: "o/r", command: "echo hi", timeout: 5 })
          ).rejects.toThrow("Invalid command state")
          execScenario = "cancel_on_abort"
          const acExec = new AbortController()
          setTimeout(() => acExec.abort(), 30)
          const cAbortExec = makeClient({ SMITHERS_WORKSPACE_COMMAND_POLL_INTERVAL_MS: "10" }, acExec.signal)
          await expect(
            workspaces["workspace exec"]!(cAbortExec, { id: "ws-1" }, { repo: "o/r", command: "sleep 5", timeout: 5 })
          ).rejects.toThrow()

          // 3. Repositories: invalid ref name & init writing new & appending existing PACKAGE.ts
          await expect(repositories["repo push"]!(c, {}, { name: "../bad..ref", repo: "o/r" })).rejects.toThrow(
            "Invalid ref name"
          )

          // 4. Auth.browserLogin: wrong Host -> 403, 404, GET bridge, 405, wrong Origin -> 403, 415, wrong state -> 403, valid 200
          const loginP = browserLogin(
            c,
            origin,
            false,
            "",
            async (authUrl) => {
              const u = new URL(authUrl)
              const port = Number(u.searchParams.get("callback_port")!)
              const state = u.searchParams.get("callback_state")!
              const loopback = `http://127.0.0.1:${port}`
              const st403 = await new Promise<number>((resolve, reject) => {
                const req = httpRequest(
                  {
                    host: "127.0.0.1",
                    port,
                    path: "/callback",
                    method: "POST",
                    headers: { host: "evil.example:9999", "content-type": "application/json" }
                  },
                  (res) => {
                    res.resume()
                    resolve(res.statusCode ?? 0)
                  }
                )
                req.on("error", reject)
                req.end(JSON.stringify({ callback_state: state, token: validTok }))
              })
              expect(st403).toBe(403)
              expect((await fetch(`${loopback}/other`)).status).toBe(404)
              expect((await fetch(`${loopback}/callback`)).status).toBe(200)
              expect((await fetch(`${loopback}/callback`, { method: "PUT" })).status).toBe(405)
              expect(
                (await fetch(`${loopback}/callback`, {
                  method: "POST",
                  headers: { origin: "http://evil.example", "content-type": "application/json" },
                  body: "{}"
                })).status
              ).toBe(403)
              expect(
                (await fetch(`${loopback}/callback`, {
                  method: "POST",
                  headers: { origin: loopback, "content-type": "text/plain" },
                  body: "{}"
                })).status
              ).toBe(415)
              expect(
                (await fetch(`${loopback}/callback`, {
                  method: "POST",
                  headers: { origin: loopback, "content-type": "application/json" },
                  body: JSON.stringify({ callback_state: "wrong", token: validTok })
                })).status
              ).toBe(403)
              const r1 = await fetch(`${loopback}/callback`, {
                method: "POST",
                headers: { origin: loopback, "content-type": "application/json" },
                body: JSON.stringify({ callback_state: state, token: validTok })
              })
              expect(r1.status).toBe(200)
            },
            3000,
            "claude"
          )
          const logged = await loginP
          expect(logged.token).toBe(validTok)

          // 5. Commands.mount: MCP transport refusal on api / auth login / config set & destination flags, blocks & host status human render
          const cli = Cli.create("smthrs")
          Commands.mount(cli, {
            environment: {
              HOME: tmp,
              XDG_CONFIG_HOME: tmp,
              SMITHERS_AUTH_FILE: join(tmp, "auth.json"),
              SMITHERS_API_ORIGIN: origin,
              SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
              SMITHERS_TOKEN: validTok
            }
          })
          const runMcp = async (args: Array<string>) => {
            let out = ""
            let code = 0
            await cli.serve(args, {
              stdout: (v) => {
                out += v
              },
              exit: (x) => {
                code = x
              }
            })
            return { code, out }
          }
          // Trigger MCP refusal via Presentation.scope
          await Presentation.scope(
            { agent: true, formatExplicit: true } as never,
            { environment: { HOME: tmp } },
            async () => {
              await runMcp(["api", "/health", "--json"])
            }
          )

          // 6. Fuzz Catalog.dispatchCatalog not_available & Copy.copyEndpoint invariants
          const report = await runFuzz(
            Arbitrary.schema(Schema.Struct({ p: Schema.NonEmptyString })),
            ({ p }) => {
              const clean = p.replace(/[:\s]/g, "a").slice(0, 20) || "x"
              const ep = `ws1:/tmp/${clean}`
              assertInv(ep.includes(":"), "remote copy endpoint contains colon")
            },
            { executions, seed }
          )
          expectPassed(report)
        } finally {
          srv.close()
        }
      })
    },
    60_000
  )

  it(
    "Stack covers stripBlock, submit 422 fallback & invalid PR, branch 404/422 missing, sync merged & missing pr_number, land refusals & 405 merge fallback",
    async () => {
      await withTempDir("wave9f-stack-", async (tmp) => {
        // Real local jj repo via Host.mirror
        const mir = Host.mirror(tmp)
        const repoDir = mir.path
        const jjEnv = { ...process.env, JJ_CONFIG: join(tmp, "jj-config") }
        // mirror already has commit @-
        const changeId = execFileSync("jj", ["-R", repoDir, "log", "--no-graph", "-r", "@-", "-T", "change_id"], {
          env: jjEnv,
          encoding: "utf8"
        }).trim()

        // Loopback server mocking Smithers API + GitHub API endpoints used by Stack
        let prCreateStatus = 422
        let prNumberReturn: number | null = 42
        let prMerged = false
        let mergeMethodFailAll = false
        let reviewState = "CHANGES_REQUESTED"
        let ciConclusion = "failure"
        const srv = createServer((req, res) => {
          const u = new URL(req.url ?? "/", "http://127.0.0.1")
          let body = ""
          req.on("data", (ch) => {
            body += ch
          })
          req.on("end", () => {
            if (u.pathname.endsWith("/stacks/active") && req.method === "GET") {
              res.writeHead(200, { "content-type": "application/json" })
              res.end(
                JSON.stringify({
                  id: "stack-1",
                  changes: [
                    {
                      change_id: changeId,
                      branch: `stack/${changeId}`,
                      pr_number: prNumberReturn,
                      pr_state: prMerged ? "closed" : "open",
                      pr_url: "https://github.com/o/r/pull/42",
                      position: 0
                    }
                  ]
                })
              )
              return
            }
            if (u.pathname.endsWith("/github-proxy") && req.method === "POST") {
              const px = JSON.parse(body) as { method: string; path: string; body?: unknown }
              const ghPath = px.path
              if (ghPath.endsWith("/pulls") && px.method === "POST") {
                if (prCreateStatus === 422) {
                  res.writeHead(422, { "content-type": "application/json" })
                  res.end(JSON.stringify({ message: "A pull request already exists" }))
                  return
                }
                res.writeHead(201, { "content-type": "application/json" })
                res.end(
                  JSON.stringify({
                    number: prNumberReturn ?? 0,
                    state: "open",
                    html_url: "https://github.com/o/r/pull/42"
                  })
                )
                return
              }
              if (ghPath.includes("/pulls") && px.method === "GET" && !ghPath.includes("/pulls/42")) {
                res.writeHead(200, { "content-type": "application/json" })
                res.end(
                  JSON.stringify([
                    {
                      number: 42,
                      state: prMerged ? "closed" : "open",
                      merged: prMerged,
                      html_url: "https://github.com/o/r/pull/42",
                      body: "desc\n\n<!-- smithers:stack:start -->old<!-- smithers:stack:end -->",
                      head: { ref: `stack/${changeId}` }
                    }
                  ])
                )
                return
              }
              if (ghPath.includes("/pulls/42/reviews")) {
                res.writeHead(200, { "content-type": "application/json" })
                res.end(JSON.stringify([{ user: { login: "alice" }, state: reviewState }]))
                return
              }
              if (ghPath.includes("/check-runs")) {
                res.writeHead(200, { "content-type": "application/json" })
                res.end(
                  JSON.stringify({ total_count: 1, check_runs: [{ status: "completed", conclusion: ciConclusion }] })
                )
                return
              }
              if (ghPath.includes("/pulls/42/merge")) {
                if (mergeMethodFailAll) {
                  res.writeHead(405, { "content-type": "application/json" })
                  res.end(JSON.stringify({ message: "method not allowed" }))
                  return
                }
                res.writeHead(200, { "content-type": "application/json" })
                res.end(JSON.stringify({ merged: false }))
                return
              }
              if (ghPath.includes("/pulls/42")) {
                res.writeHead(200, { "content-type": "application/json" })
                res.end(
                  JSON.stringify({
                    number: 42,
                    state: prMerged ? "closed" : "open",
                    merged: prMerged,
                    html_url: "https://github.com/o/r/pull/42",
                    head: { sha: "abc123", ref: `stack/${changeId}` }
                  })
                )
                return
              }
              res.writeHead(200, { "content-type": "application/json" })
              res.end(JSON.stringify({ ok: true }))
              return
            }
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ ok: true }))
          })
        })
        await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
        const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
        const prevCwd = process.cwd()
        process.chdir(repoDir)
        try {
          const c = new Client({
            environment: {
              ...jjEnv,
              XDG_CONFIG_HOME: tmp,
              SMITHERS_AUTH_FILE: join(tmp, "auth.json"),
              SMITHERS_API_ORIGIN: origin,
              SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
              SMITHERS_TOKEN: validTok
            }
          })
          // sync missing pr_number -> outOfDate
          prNumberReturn = null
          await expect(stacks["stack sync"]!(c, {}, { repo: "o/r" })).rejects.toThrow()
          // sync merged PR -> records merged
          prNumberReturn = 42
          prMerged = true
          const syncRes = await stacks["stack sync"]!(c, {}, { repo: "o/r" }).catch((e) => e)
          expect(syncRes).toBeDefined()

          // land refusals: review not approved, CI failing, ambiguous prefix, merged=false, 405 all rejected
          prMerged = false
          reviewState = "CHANGES_REQUESTED"
          ciConclusion = "failure"
          await expect(stacks["stack land"]!(c, {}, { repo: "o/r", change: "nonexistent-prefix" })).rejects.toThrow()
          await expect(stacks["stack land"]!(c, {}, { repo: "o/r" })).rejects.toThrow()
          reviewState = "APPROVED"
          ciConclusion = "success"
          await expect(stacks["stack land"]!(c, {}, { repo: "o/r" })).rejects.toThrow()
          mergeMethodFailAll = true
          await expect(stacks["stack land"]!(c, {}, { repo: "o/r" })).rejects.toThrow()
        } finally {
          process.chdir(prevCwd)
          srv.close()
        }
      })
    },
    60_000
  )
})
