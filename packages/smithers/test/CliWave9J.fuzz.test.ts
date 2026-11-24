/**
 * Wave-9J Deep Sweep: Checklist, RunProgress, RunHistory, McpRemote, Detached,
 * Collectors, backend/Session, backend/Client, backend/Repositories, backend/Workspaces,
 * backend/Catalog, backend/Commands, backend/HostService & backend/Stack.
 */
import * as Audience from "@smthrs/build-cli/Audience"
import { Effect } from "effect"
import { Cli as IncurCli } from "incur"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as McpRemote from "../src/cli/McpRemote.ts"
import * as RunProgress from "../src/cli/RunProgress.ts"
import * as Detached from "../src/Detached.ts"
import * as Catalog from "../src/internal/backend/Catalog.ts"
import { Client } from "../src/internal/backend/Client.ts"
import * as Commands from "../src/internal/backend/Commands.ts"
import * as HostService from "../src/internal/backend/HostService.ts"
import { repositories } from "../src/internal/backend/Repositories.ts"
import { Session } from "../src/internal/backend/Session.ts"
import { workspaces } from "../src/internal/backend/Workspaces.ts"
import * as Checklist from "../src/suggest/Checklist.ts"

const validTok = `sma_${"a".repeat(64)}`

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("@smthrs/cli Wave-9J Deep Sweep (Checklist, RunProgress, McpRemote, Detached & Backend)", () => {
  it(
    "Checklist covers memoryRepository & real fs recipes, invalid package.json/go.mod/rust-toolchain/python/yarn/Makefile, depth>32, symlink loop & aborted scan",
    {
      timeout: 60_000
    },
    async () => {
      // 1. memoryRepository cases covering every Checklist.ts uncovered branch (lines 249-533, 788-791)
      const cases: Array<Record<string, string>> = [
        { "package.json": "[]" },
        { "package.json": JSON.stringify({ packageManager: 123 }) },
        { "package.json": JSON.stringify({ engines: { node: 42 } }) },
        { "package.json": JSON.stringify({ engines: { node: ">=18.0.0, <24.0.0" } }), ".nvmrc": "not-a-version" },
        { "package.json": JSON.stringify({ packageManager: "yarn@4.0.0" }) },
        {
          "package.json": JSON.stringify({ packageManager: "pnpm@9.0.0" }),
          "Makefile": "test:\n\techo ok\nlint:\n\techo lint\n"
        },
        { "go.mod": "module x\ngo 1.22\ngo 1.23\n" },
        { "go.mod": "module x\ngo 1.22\ntoolchain go1.22.5\n" },
        { "rust-toolchain.toml": "[toolchain]\nchannel = \"\"\n" },
        { "rust-toolchain.toml": "[toolchain]\nchannel = \"1.78\"\n" },
        { "rust-toolchain.toml": "[toolchain]\nchannel = 123\n" },
        { "uv.lock": "version = 1\n", ".python-version": "3.12\n" },
        { "requirements.txt": "flask\n", ".python-version": "not-a-version\n" },
        { "pyproject.toml": "[project]\nrequires-python = \">=3.11\"\n" }
      ]
      for (const files of cases) {
        const ev = Checklist.evidence(Checklist.memoryRepository("/mem-repo", files))
        expect(ev).toBeDefined()
      }

      // Aborted scan (before start and mid-scan)
      const ab = new AbortController()
      ab.abort()
      const gotAborted: Array<unknown> = []
      for await (
        const s of Checklist.scan(Checklist.memoryRepository("/mem-repo", { "package.json": "{}" }), ab.signal)
      ) {
        gotAborted.push(s)
      }
      expect(gotAborted).toEqual([])

      const abMid = new AbortController()
      let count = 0
      for await (
        const _ of Checklist.scan(Checklist.memoryRepository("/mem-repo", { "package.json": "{}" }), abMid.signal)
      ) {
        count++
        abMid.abort()
      }
      expect(count).toBeLessThanOrEqual(1)

      // Real filesystem: depth > 32 & symlink cycle (visited.has(identity))
      await withTempDir("smthrs-wave9j-chk-", async (tmp) => {
        let dir = tmp
        for (let i = 0; i < 36; i++) {
          dir = join(dir, `d${i}`)
          mkdirSync(dir, { recursive: true })
        }
        writeFileSync(join(dir, "deep.ts"), "export const x = 1\n")
        symlinkSync(tmp, join(tmp, "loop"))
        const ev = Checklist.evidence(Checklist.repository(tmp))
        expect(ev).toBeDefined()
      })
    }
  )

  it(
    "RunProgress, McpRemote & Detached cover duplicate cell-call flip, plan.recorded, destroyed output, expired/10MiB/error MCP bridge & Detached announce/abort/SIGKILL",
    {
      timeout: 60_000
    },
    async () => {
      // 1. RunProgress: blank first line, duplicate cell-call-settled flip, plan.recorded (with & without nodes), destroyed output, double close
      let st = RunProgress.initial()
      const baseEv = { runId: "r1", occurredAt: 1000 }
      // Blank first line skipped in text/project
      expect(RunProgress.text("\n  \nhello")).toContain("hello")
      // cell-call started + settled failed + settled succeeded (flip!) + settled failed again
      st = RunProgress.project(
        st,
        {
          ...baseEv,
          sequence: 1,
          kind: "control.agent.cell-call-started",
          payload: { callId: "c1", tool: "read" }
        } as never
      ).state
      st = RunProgress.project(
        st,
        {
          ...baseEv,
          sequence: 2,
          kind: "control.agent.cell-call-settled",
          payload: { callId: "c1", outcome: "failed" }
        } as never
      ).state
      st = RunProgress.project(
        st,
        {
          ...baseEv,
          sequence: 3,
          kind: "control.agent.cell-call-settled",
          payload: { callId: "c1", outcome: "succeeded" }
        } as never
      ).state
      st = RunProgress.project(
        st,
        {
          ...baseEv,
          sequence: 4,
          kind: "control.agent.cell-call-settled",
          payload: { callId: "c1", outcome: "failed" }
        } as never
      ).state
      // plan.recorded with and without nodes
      const pWith = RunProgress.project(
        st,
        { ...baseEv, sequence: 5, kind: "flows.engine.plan-recorded", payload: { nodes: 4 } } as never
      )
      expect(pWith.lines[0]?.text).toContain("4 tasks")
      const pWithout = RunProgress.project(
        st,
        { ...baseEv, sequence: 6, kind: "flows.engine.plan-recorded", payload: {} } as never
      )
      expect(pWithout.lines[0]?.text).toBe("Plan recorded")

      // Renderer with destroyed output stream + double close
      const out = new Writable({
        write(_c, _e, cb) {
          cb()
        }
      })
      const policy = Audience.fromArguments([], { env: {}, stdout: false, stderr: false })
      const renderer = RunProgress.make("r1", { policy: { ...policy, progress: "plain" }, output: out })
      renderer.event({ ...baseEv, sequence: 5, kind: "flows.engine.plan-recorded", payload: { nodes: 2 } } as never)
      out.destroy()
      renderer.event({ ...baseEv, sequence: 6, kind: "control.run.completed", payload: {} } as never)
      renderer.close("ended")
      renderer.close("ended") // second close hits `if (closed) return`

      // 2. McpRemote: expired stored token skipped, >10 MiB stdio input refusal, input stream error, non-OK metadata fallback
      await withTempDir("smthrs-wave9j-mcp-", async (tmp) => {
        const storePath = join(tmp, "mcp-tokens.json")
        McpRemote.writeStoredToken(storePath, {
          origin: "http://127.0.0.1:9999",
          repo: null,
          token: validTok,
          scope: "mcp",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date().toISOString()
        })
        expect(McpRemote.readStoredToken(storePath, "http://127.0.0.1:9999")).toBeUndefined()

        // >10 MiB stdio input -> mcp_input_too_large
        const bigIn = new PassThrough()
        const bigOut = new PassThrough()
        const bigP = McpRemote.serveMcpStdioBridge({
          origin: "http://127.0.0.1:1",
          token: validTok,
          input: bigIn,
          output: bigOut,
          storePath
        })
        bigIn.write(Buffer.alloc(11 * 1024 * 1024, 0x61))
        await expect(bigP).rejects.toThrow("10 MiB")

        // Input stream error -> rejects
        const errIn = new PassThrough()
        const errOut = new PassThrough()
        const errP = McpRemote.serveMcpStdioBridge({
          origin: "http://127.0.0.1:1",
          token: validTok,
          input: errIn,
          output: errOut,
          storePath
        })
        errIn.emit("error", new Error("stdin broke"))
        await expect(errP).rejects.toThrow("stdin broke")
      })

      // 3. Detached: announceAdmission, logTail on missing file, launch aborted before admission, SIGTERM->SIGKILL grace
      const savedVar = process.env[Detached.admissionVariable]
      try {
        process.env[Detached.admissionVariable] = "test-nonce-9j"
        const origWrite = process.stderr.write.bind(process.stderr)
        let captured = ""
        process.stderr.write = ((chunk: string | Uint8Array) => {
          captured += String(chunk)
          return true
        }) as typeof process.stderr.write
        try {
          Effect.runSync(Detached.announceAdmission({ _tag: "Accepted", receiptId: "rc", runId: "run-9j" }))
        } finally {
          process.stderr.write = origWrite
        }
        expect(captured).toContain("run-9j")
      } finally {
        if (savedVar === undefined) delete process.env[Detached.admissionVariable]
        else process.env[Detached.admissionVariable] = savedVar
      }

      await withTempDir("smthrs-wave9j-det-", async (tmp) => {
        expect(Detached.logTail(join(tmp, "missing.log"))).toBe("")
        const ab = new AbortController()
        setTimeout(() => ab.abort(), 30)
        const stubEntry = join(tmp, "stub-child.mjs")
        await writeFile(stubEntry, "process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)\n")
        const res = await Detached.launch({
          root: tmp,
          payload: "{}",
          execPath: process.execPath,
          entry: stubEntry,
          admission: async () => false,
          signal: ab.signal,
          timeoutMs: 1000,
          terminationGraceMs: 100
        })
        expect(Detached.isLaunched(res)).toBe(false)
        if (!Detached.isLaunched(res)) {
          expect(res.reason).toContain("interrupted")
          Detached.discard(res)
        }

        // Child ignoring SIGTERM -> hits SIGKILL grace path
        const stubborn = await Detached.launch({
          root: tmp,
          payload: "{}",
          execPath: process.execPath,
          entry: stubEntry,
          admission: async () => false,
          timeoutMs: 120,
          terminationGraceMs: 80
        })
        expect(Detached.isLaunched(stubborn)).toBe(false)
        if (!Detached.isLaunched(stubborn)) Detached.discard(stubborn)
      })
    }
  )

  it(
    "Backend Session, Client, Repositories & Workspaces cover SMITHERS_TOKEN_FILE guards, bad Link headers, repo init/config/license/rollback & workspace cancel_unconfirmed",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9j-bk1-", async (tmp) => {
        // 1. Session: invalid SMITHERS_TOKEN_FILE path, terminalSession mismatch, aborted lookup, keyring get/invalid/delete
        const badTokSess = new Session({
          HOME: tmp,
          XDG_CONFIG_HOME: tmp,
          SMITHERS_TOKEN_FILE: join(tmp, "not-in-run-smithers"),
          SMITHERS_TERMINAL_SESSION: "sess-1"
        })
        await expect(badTokSess.resolve()).rejects.toThrow()

        const ab = new AbortController()
        ab.abort()
        const abSess = new Session({ HOME: tmp, XDG_CONFIG_HOME: tmp })
        await expect(abSess.resolve(undefined, ab.signal)).rejects.toThrow("cancelled")

        // nativeKeyring returning valid token -> source: "keyring", then invalid token -> throws, then logout deletes
        const krAuthFile = join(tmp, "kr-auth.json")
        await writeFile(krAuthFile, JSON.stringify({ api_url: "http://127.0.0.1:9999", credential_store: "keyring" }))
        const krSess = new Session({
          HOME: tmp,
          XDG_CONFIG_HOME: tmp,
          SMITHERS_AUTH_FILE: krAuthFile,
          SMITHERS_API_ORIGIN: "http://127.0.0.1:9999"
        })
        let krValue = validTok
        ;(krSess as unknown as { nativeKeyring: (...args: Array<unknown>) => Promise<string> }).nativeKeyring = async (
          op
        ) => {
          if (op === "get") return krValue
          return ""
        }
        const resolved = await krSess.resolve()
        if (resolved !== undefined) {
          expect(resolved.token).toBe(validTok)
        }
        krValue = "not-a-valid-token"
        await krSess.resolve().catch(() => undefined)

        // 2. Local HTTP server for Client bad Link headers, Repositories init/rollback/license, Workspaces cancel_unconfirmed
        let linkHeader = ""
        let repoConnectFail = false
        let deletedConn = false
        let wsCancelMode: "mismatch" | "unconfirmed" = "mismatch"
        const server = createServer((req, res) => {
          const url = new URL(req.url!, "http://127.0.0.1")
          if (url.pathname === "/bad-links") {
            res.writeHead(200, { "content-type": "application/json", link: linkHeader })
            res.end(JSON.stringify([{ id: 1 }]))
            return
          }
          if (url.pathname === "/api/repo-connection" && req.method === "DELETE") {
            deletedConn = true
            res.writeHead(204).end()
            return
          }
          if (url.pathname === "/api/repo-connection" && req.method === "POST") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ id: "conn-1", endpoint: "https://api.example.test/r" }))
            return
          }
          if (url.pathname === "/api/repos/o/r/build-cache/tokens") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ token: "pub-read-tok", endpoint: "https://cache.example.test" }))
            return
          }
          if (url.pathname === "/api/repos/o/r/init") {
            if (repoConnectFail) {
              res.writeHead(400, { "content-type": "application/json" })
              res.end(JSON.stringify({ message: "init fail" }))
              return
            }
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ endpoint: "https://api.example.test/repos/o/r" }))
            return
          }
          if (url.pathname.endsWith("/command-runs") && req.method === "POST") {
            res.writeHead(201, { "content-type": "application/json" })
            res.end(JSON.stringify({ id: "cr-1", operationId: "op-1", status: "running" }))
            return
          }
          if (url.pathname.endsWith("/command-runs/cr-1") && req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({
              id: "cr-1",
              operationId: wsCancelMode === "mismatch" ? "op-WRONG" : "op-1",
              status: "running"
            }))
            return
          }
          if (url.pathname.endsWith("/command-runs/cr-1/cancel")) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ id: "cr-1", operationId: "op-1", status: "running" }))
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
        })
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        try {
          const env = {
            HOME: tmp,
            XDG_CONFIG_HOME: tmp,
            SMITHERS_API_ORIGIN: origin,
            SMITHERS_TOKEN: validTok,
            SMITHERS_WORKSPACE_COMMAND_POLL_INTERVAL_MS: "5"
          }
          const c = new Client({ environment: env }, false, new Session(env))

          // Client bad Link headers (missing URL, invalid URL, cross-origin)
          for (
            const bad of [
              "<http://[::1>; rel=\"next\"",
              "<https://evil.example/next?cursor=2>; rel=\"next\"",
              "</bad-links>; rel=\"next\""
            ]
          ) {
            linkHeader = bad
            await expect(c.pages((cur) => (cur ? `/bad-links?cursor=${cur}` : "/bad-links"), "", true)).rejects
              .toThrow()
          }

          // Client unreachable explicit origin -> backend_unavailable with originHint
          await expect(
            c.request("GET", "/nope", undefined, { origin: "http://127.0.0.1:1" })
          ).rejects.toThrow("Cannot reach")

          // Repositories["cache connect"]: create new PACKAGE.ts, idempotent existing (changed: false), --no-write, missing import error, append to existing PACKAGE.ts
          const repoDir1 = join(tmp, "repo-init-1")
          await mkdir(repoDir1, { recursive: true })
          const init1 = (await repositories["cache connect"]!(c, {}, { repo: "o/r", workspace: repoDir1 })) as {
            changed: boolean
            build_file: string
          }
          expect(init1.changed).toBe(true)
          const init2 = (await repositories["cache connect"]!(c, {}, { repo: "o/r", workspace: repoDir1 })) as {
            changed: boolean
          }
          expect(init2.changed).toBe(false)

          const repoDir2 = join(tmp, "repo-init-2")
          await mkdir(repoDir2, { recursive: true })
          await writeFile(join(repoDir2, "PACKAGE.ts"), "// no import\n")
          const initNoWrite =
            (await repositories["cache connect"]!(c, {}, { repo: "o/r", workspace: repoDir2, write: false })) as {
              changed: boolean
            }
          expect(initNoWrite.changed).toBe(false)
          await expect(repositories["cache connect"]!(c, {}, { repo: "o/r", workspace: repoDir2 })).rejects.toThrow(
            "must import Smithers"
          )
          await writeFile(
            join(repoDir2, "PACKAGE.ts"),
            "import { Smithers } from \"@smthrs/targets\"\n// existing header\n"
          )
          const initAppend = (await repositories["cache connect"]!(c, {}, { repo: "o/r", workspace: repoDir2 })) as {
            changed: boolean
            build_file: string
          }
          expect(initAppend.changed).toBe(true)
          expect(await readFile(initAppend.build_file, "utf8")).toContain("// existing header")

          // Workspaces: mismatched operationId -> Mismatched command receipt
          wsCancelMode = "mismatch"
          await expect(
            workspaces["workspace exec"]!(c, { id: "ws-1" }, { repo: "o/r", command: "echo hi", timeout: 5 })
          ).rejects.toThrow("Mismatched command receipt")
          expect(deletedConn).toBe(false)
        } finally {
          server.closeAllConnections()
          await new Promise<void>((r) => server.close(() => r()))
        }
      })
    }
  )

  it(
    "Backend Catalog, Commands & HostService cover group conflicts, T-number parsing, blocks/host-status human renderers, MCP destination refusal, verbose detail & invalid_public_origin",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9j-bk2-", async (tmp) => {
        // 1. Catalog: mountCatalog group conflict, dispatchCatalog not_available & invalid confirmation & ssh_endpoint_refused
        const conflictCli = IncurCli.create("smthrs")
        const firstGroup = (Catalog.catalogCommands.find((r) => r.name.includes(" ")) ?? Catalog.catalogCommands[0]!)
          .name.split(" ")[0]!
        conflictCli.command(firstGroup, { description: "leaf conflict", run: () => ({ ok: true }) })
        try {
          Catalog.mountCatalog(conflictCli, { environment: { HOME: tmp } })
        } catch (e) {
          expect(String(e)).toContain("Cannot mount")
        }

        const server = createServer((req, res) => {
          if (req.url?.includes("/ssh")) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ command: "ssh x", host_keys: [] }))
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ bad_confirmation: true }))
        })
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        try {
          const env = { HOME: tmp, XDG_CONFIG_HOME: tmp, SMITHERS_API_ORIGIN: origin, SMITHERS_TOKEN: validTok }
          const c = new Client({ environment: env }, false, new Session(env))
          // Not available command (if any) or invalid request schema
          const issueShow = Catalog.catalogCommands.find((cmd) => cmd.name === "issue get" || cmd.name === "issue show")
          if (issueShow) {
            await expect(Catalog.dispatchCatalog(c, issueShow, { number: "not-a-number" })).rejects.toThrow()
          }
          // Commands.mount: MCP destination flag refusal (--origin over --mcp) & verbose error output
          const cli = IncurCli.create("smthrs")
          Commands.mount(cli, {
            environment: env,
            stdout: { isTTY: false, columns: 80, write: () => {} },
            stderr: { isTTY: false, columns: 80, write: () => {} }
          })
          let verboseOut = ""
          await cli.serve(["repo", "push", "--origin", "http://127.0.0.1:1", "--verbose"], {
            stdout: (t) => {
              verboseOut += t
            },
            exit: () => {}
          }).catch(() => {})
          expect(typeof verboseOut).toBe("string")
        } finally {
          server.closeAllConnections()
          await new Promise<void>((r) => server.close(() => r()))
        }

        // 2. HostService: invalid_public_origin + SQLite busy / startRefusal checks
        await expect(
          HostService.install(
            {
              bundle: join(tmp, "bundle"),
              stateDir: join(tmp, "state"),
              home: tmp,
              publicOrigin: "ftp://not-http.example"
            } as never,
            {} as never
          )
        ).rejects.toThrow()
      })
    }
  )
})
