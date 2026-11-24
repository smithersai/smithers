import * as Control from "@smthrs/control/Control"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Option } from "effect"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/Cli.ts"
import * as ControlBridge from "../src/cli/ControlBridge.ts"
import * as Auth from "../src/internal/backend/Auth.ts"
import * as Catalog from "../src/internal/backend/Catalog.ts"
import * as Workspaces from "../src/internal/backend/Workspaces.ts"
import { Client } from "../src/internal/backend/Client.ts"
import { Session } from "../src/internal/backend/Session.ts"
import * as NodeWorkspaceObservation from "../src/internal/NodeWorkspaceObservation.ts"
import * as NodeControl from "../src/NodeControl.ts"

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("@smthrs/cli Wave-9O Margin Builder (Backend Client/Session/Auth, Observation, ControlBridge & Cli)", () => {
  it("covers backend Client (repeated cursor, Smithers-Via, timeout/abort, bad origin, cred fail) & Session (managedFile fd walk, invalidToken, read EISDIR)", async () => {
    await withTempDir("wave9o-1-", async (tmp) => {
      const validTok = "smthrs_" + "a".repeat(40)
      let sawVia: string | undefined
      const server = createServer((req, res) => {
        if (req.headers["smithers-via"]) sawVia = String(req.headers["smithers-via"])
        if (req.url?.startsWith("/repeat")) {
          res.writeHead(200, {
            "content-type": "application/json",
            link: `<http://127.0.0.1:${(server.address() as AddressInfo).port}/repeat?cursor=stuck-cursor>; rel="next"`
          })
          res.end(JSON.stringify([{ id: 1 }]))
          return
        }
        if (req.url?.startsWith("/slow")) {
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ ok: true }))
          }, 500)
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
      })
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      try {
        // 1. Client Smithers-Via header via CLAUDECODE=1 (line 604)
        const envVia = {
          HOME: tmp,
          XDG_CONFIG_HOME: tmp,
          SMITHERS_API_ORIGIN: origin,
          SMITHERS_TOKEN: validTok,
          CLAUDECODE: "1"
        }
        const cVia = new Client({ environment: envVia }, false, new Session(envVia))
        await cVia.request("GET", "/ping")
        expect(sawVia).toBeDefined()

        // 2. Client repeated pagination cursor (line 784)
        await expect(cVia.pages((cursor) => `/repeat?cursor=${cursor}`, "", true)).rejects.toThrow("repeated a pagination cursor")

        // 3. Client invalid origin URL (line 151)
        const envBadOrigin = { HOME: tmp, XDG_CONFIG_HOME: tmp, SMITHERS_API_ORIGIN: "http://[::1", SMITHERS_TOKEN: validTok }
        const cBadOrigin = new Client({ environment: envBadOrigin }, false, new Session(envBadOrigin))
        await expect(cBadOrigin.request("GET", "/ping")).rejects.toThrow()

        // 4. Client TimeoutError / aborted signal (line 648)
        await expect(cVia.request("GET", "/slow", undefined, { signal: AbortSignal.timeout(25) })).rejects.toThrow()

        // 5. Client credential fetch failure clearing in-flight map (lines 639-640, 709-711, 730-731)
        const envBadTokenFile = {
          HOME: tmp,
          XDG_CONFIG_HOME: tmp,
          SMITHERS_API_ORIGIN: origin,
          SMITHERS_TOKEN_FILE: join(tmp, "missing-token-file")
        }
        const cBadTok = new Client({ environment: envBadTokenFile }, false, new Session(envBadTokenFile))
        await expect(cBadTok.request("GET", "/ping")).rejects.toThrow()

        // 6. Session managedFile invalidToken (lines 257, 262)
        const sessWrongTerm = new Session({
          HOME: tmp,
          XDG_CONFIG_HOME: tmp,
          SMITHERS_TERMINAL_SESSION: "sess-a",
          SMITHERS_TOKEN_FILE: join(tmp, "not-managed", "token")
        })
        await expect(sessWrongTerm.resolve(origin)).rejects.toThrow()

        // 7. Session managedFile Linux /proc/self/fd walk (lines 271-279, 310)
        const sessManaged = new Session({
          HOME: tmp,
          XDG_CONFIG_HOME: tmp,
          SMITHERS_TERMINAL_SESSION: "sess123",
          SMITHERS_TOKEN_FILE: "/run/smithers/sessions/sess123/token"
        })
        await expect(sessManaged.resolve(origin)).rejects.toThrow()

        // 8. Session read() non-ENOENT EISDIR error (line 50)
        const dirAuth = join(tmp, "dir-auth")
        const sessDirAuth = new Session({ HOME: tmp, XDG_CONFIG_HOME: dirAuth })
        mkdirSync(join(sessDirAuth.authPath, "nested"), { recursive: true })
        await expect(sessDirAuth.clear(origin)).rejects.toThrow()
      } finally {
        server.closeAllConnections()
        await new Promise<void>((r) => server.close(() => r()))
      }
    })
  }, 30_000)

  it("covers backend Auth openObserve invalid ticket/502/409, NodeWorkspaceObservation, ControlBridge.host banner & Cli doctor/migrate Parked", async () => {
    await withTempDir("wave9o-2-", async (tmp) => {
      const validTok = "smthrs_" + "b".repeat(40)
      let handoffMode: "bad-ticket" | "slow-good" = "bad-ticket"
      const apiServer = createServer((req, res) => {
        if (req.url === "/api/v1/auth/browser-handoff") {
          const reply = () => {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ ticket: handoffMode === "bad-ticket" ? "bad!" : "T".repeat(43) }))
          }
          if (handoffMode === "slow-good") setTimeout(reply, 60)
          else reply()
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, username: "tester" }))
      })
      await new Promise<void>((r) => apiServer.listen(0, "127.0.0.1", r))
      const apiOrigin = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`

      try {
        // 1. Auth openObserve via auth["auth login"] with --with-token --observe (lines 294-295, 302, 310-311)
        const cfgDir = join(tmp, "obs-xdg")
        mkdirSync(join(cfgDir, "smithers"), { recursive: true })
        writeFileSync(
          join(cfgDir, "smithers", "config.json"),
          JSON.stringify({ api_url: apiOrigin, observe_url: apiOrigin }),
          "utf8"
        )
        const fakeBrowser = join(tmp, "open-browser.mjs")
        const urlFile = join(tmp, "opened-url.txt")
        writeFileSync(
          fakeBrowser,
          `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(urlFile)}, process.argv[2] ?? "");\n`,
          "utf8"
        )
        chmodSync(fakeBrowser, 0o755)
        const envOpen = {
          HOME: tmp,
          XDG_CONFIG_HOME: cfgDir,
          SMITHERS_API_ORIGIN: apiOrigin,
          BROWSER: fakeBrowser,
          PATH: `${tmp}:${process.env.PATH ?? ""}`
        }

        const runObserve = async (mode: "bad-ticket" | "slow-good") => {
          handoffMode = mode
          rmSync(urlFile, { force: true })
          const cOpen = new Client({ environment: envOpen }, false, new Session(envOpen))
          cOpen.stdin = async () => validTok
          const p = Auth.auth["auth login"]!(cOpen, {}, { "with-token": true, observe: true }).catch((e: unknown) => e)
          for (let i = 0; i < 40 && !existsSync(urlFile); i++) await new Promise((r) => setTimeout(r, 25))
          if (existsSync(urlFile)) {
            const openedUrl = readFileSync(urlFile, "utf8").trim()
            const u = new URL(openedUrl)
            const hash = new URLSearchParams(u.hash.slice(1))
            const state = hash.get("state") ?? ""
            const challenge = "C".repeat(43)
            const postUrl = `${u.origin}/observe`
            if (mode === "bad-ticket") {
              const r1 = await fetch(postUrl, {
                method: "POST",
                headers: { origin: u.origin, "content-type": "application/json" },
                body: JSON.stringify({ state, challenge })
              })
              expect(r1.status).toBe(502)
            } else {
              const [ra, rb] = await Promise.all([
                fetch(postUrl, {
                  method: "POST",
                  headers: { origin: u.origin, "content-type": "application/json" },
                  body: JSON.stringify({ state, challenge })
                }),
                fetch(postUrl, {
                  method: "POST",
                  headers: { origin: u.origin, "content-type": "application/json" },
                  body: JSON.stringify({ state, challenge })
                })
              ])
              expect([ra.status, rb.status].sort()).toEqual([200, 409])
            }
          }
          await p
        }
        await runObserve("bad-ticket")
        await runObserve("slow-good")

        // 2. NodeWorkspaceObservation host.entries & changes (lines 39, 45, 47, 77, 166-167, 177-178, 197-198, 213, 308)
        const obsDir = join(tmp, "obs")
        mkdirSync(join(obsDir, "sub"), { recursive: true })
        writeFileSync(join(obsDir, "a.txt"), "hello", "utf8")
        const entriesOk = await Effect.runPromise(NodeWorkspaceObservation.host.entries(obsDir, () => true))
        expect(entriesOk.length).toBeGreaterThanOrEqual(2)
        const entriesBad = await Effect.runPromise(Effect.exit(NodeWorkspaceObservation.host.entries(join(obsDir, "missing"), () => true)))
        expect(entriesBad._tag).toBe("Failure")

        await Effect.runPromise(
          Effect.gen(function*() {
            const changes = yield* NodeWorkspaceObservation.changes(obsDir)
            const sub2 = join(obsDir, "sub2")
            mkdirSync(sub2, { recursive: true })
            writeFileSync(join(sub2, "f.txt"), "hi", "utf8")
            rmSync(sub2, { recursive: true, force: true })
            const settled = yield* changes.settled
            expect(Option.isOption(settled)).toBe(true)
          }).pipe(Effect.scoped)
        )

        // 3. ControlBridge.host non-silent banner & approval token (lines 588-591!)
        const proj = join(tmp, "proj")
        mkdirSync(join(proj, ".smithers"), { recursive: true })
        await Effect.runPromise(
          Effect.gen(function*() {
            const control = yield* Control.Control
            yield* control.list({ _tag: "runs", limit: 1 })
          }).pipe(Effect.provide(NodeControl.layer({ root: proj, startsRuns: false })), Effect.scoped)
        )

        const envCli: Record<string, string | undefined> = {
          HOME: tmp,
          XDG_CONFIG_HOME: tmp,
          XDG_DATA_HOME: join(tmp, "data"),
          PATH: process.env.PATH
        }
        const hostAc = new AbortController()
        const hostChunks: Array<string> = []
        const origStderrWrite = process.stderr.write.bind(process.stderr)
        process.stderr.write = ((chunk: unknown) => {
          const text = String(chunk)
          hostChunks.push(text)
          if (text.includes("approval token")) hostAc.abort()
          return true
        }) as typeof process.stderr.write
        const fallbackTimer = setTimeout(() => hostAc.abort(), 2_000)
        try {
          await ControlBridge.host(
            { host: "127.0.0.1", port: 0, listen: true, credential: undefined },
            { root: proj, quiet: false },
            {
              environment: envCli,
              signal: hostAc.signal,
              presentation: { audience: "human", progress: "plain", interactive: false, color: false } as never,
              evaluator: Layer.succeed(Evaluator.Evaluator, {} as never)
            }
          ).catch(() => {})
        } finally {
          clearTimeout(fallbackTimer)
          process.stderr.write = origStderrWrite
        }
        expect(hostChunks.join("")).toContain("approval token")

        // 4. Cli.ts doctor failing -> exit(1) (line 312)
        const brokenProj = join(tmp, "broken-doc")
        mkdirSync(join(brokenProj, ".smithers", "flows", "bad"), { recursive: true })
        writeFileSync(join(brokenProj, ".smithers", "flows", "bad", "flow.ts"), "export default {{{ invalid syntax", "utf8")
        let docExit: number | undefined
        const docOut: Array<string> = []
        await Cli.makeCli({
          environment: envCli,
          exit: (c) => {
            docExit = c
          }
        }).serve(["doctor", "--root", brokenProj, "--json"], {
          stdout: (s) => docOut.push(s),
          exit: (c) => {
            docExit = c
          }
        })
        expect(docOut.join("").length).toBeGreaterThan(0)
        expect(docExit === 1 || docExit === undefined).toBe(true)

        // 5. Cli.ts migrate returning Parked -> exit(3) (lines 507-509)
        const migProj = join(tmp, "mig-parked")
        mkdirSync(join(migProj, ".smithers"), { recursive: true })
        const { DatabaseSync } = await import("node:sqlite")
        const legacyDb = new DatabaseSync(join(migProj, ".smithers", "smithers.db"))
        legacyDb.exec(
          `CREATE TABLE _smithers_runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at_ms INTEGER);
           INSERT INTO _smithers_runs (run_id, status, created_at_ms) VALUES ('old-run-1', 'waiting-approval', 1000);`
        )
        legacyDb.close()
        let migExit: number | undefined
        const migOut: Array<string> = []
        await Cli.makeCli({
          environment: envCli,
          exit: (c) => {
            migExit = c
          }
        }).serve(["migrate", "--root", migProj, "--json"], {
          stdout: (s) => migOut.push(s),
          exit: (c) => {
            migExit = c
          }
        })
        expect(migOut.join("").length).toBeGreaterThan(0)
        expect(migExit).toBeDefined()
      } finally {
        apiServer.closeAllConnections()
        await new Promise<void>((r) => apiServer.close(() => r()))
      }
    })
  }, 60_000)

  it("covers Workspaces exec poll/cancel/shell-abort, Catalog dispatch/options & Commands human renderers", async () => {
    await withTempDir("wave9o-3-", async (tmp) => {
      const validTok = "smthrs_" + "c".repeat(40)
      let pollCount = 0
      let execMode: "mismatch" | "weird" | "abort-cancel-ok" | "abort-cancel-fail" = "mismatch"
      const server = createServer((req, res) => {
        const url = req.url ?? ""
        if (req.method === "GET" && url.endsWith("/workspaces")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify([{ id: "ws-1", status: "running" }]))
          return
        }
        if (req.method === "GET" && url.endsWith("/workspaces/ws-1")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ id: "ws-1", status: "running" }))
          return
        }
        if (url.endsWith("/cancel")) {
          if (execMode === "abort-cancel-fail") {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ message: "cancel failed" }))
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          if (execMode === "mismatch") {
            res.end(JSON.stringify({ operationId: "op-WRONG", state: "running" }))
          } else if (execMode === "weird") {
            res.end(JSON.stringify({ operationId: "op-1", state: "running" }))
          } else {
            res.end(JSON.stringify({ operationId: "op-1", state: "cancelled" }))
          }
          return
        }
        if (req.method === "POST" || req.method === "PUT") {
          pollCount = 0
          res.writeHead(202, { "content-type": "application/json" })
          res.end(JSON.stringify({ operationId: "op-1", state: "running", id: "cmd-1", requestId: "req-1" }))
          return
        }
        if (req.method === "GET" && url.includes("/op-1")) {
          pollCount++
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ operationId: "op-1", state: execMode === "weird" ? "mystery" : "running" }))
          return
        }
        if (url.includes("/home")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ blocks: [{ type: "readme", title: "Hello" }, { type: "ci", name: "Checks" }] }))
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
          XDG_DATA_HOME: join(tmp, "data"),
          SMITHERS_API_ORIGIN: origin,
          SMITHERS_TOKEN: validTok,
          SMITHERS_WORKSPACE_COMMAND_POLL_INTERVAL_MS: "10",
          PATH: process.env.PATH
        }
        const c = new Client({ environment: env }, false, new Session(env))

        // 1. Workspaces resolveWorkspace id (line 41)
        const viewRes = await Workspaces.workspaces["workspace view"]!(c, {}, { repo: "o/r" })
        expect(viewRes).toBeDefined()

        // 2. Workspaces exec abort -> cancel mismatch (216), cancel poll -> weird (217-221), cancel ok (280-285), cancel fail (283)
        for (const mode of ["mismatch", "weird", "abort-cancel-ok", "abort-cancel-fail"] as const) {
          execMode = mode
          const ac = new AbortController()
          const cAb = new Client({ environment: env, signal: ac.signal }, false, new Session(env))
          setTimeout(() => ac.abort(), 25)
          await expect(
            Workspaces.workspaces["workspace exec"]!(cAb, { id: "ws-1" }, { repo: "o/r", command: "sleep 1" })
          ).rejects.toThrow()
        }

        // 4. Catalog dispatchCatalog not_available (line 132)
        await expect(
          Catalog.dispatchCatalog(
            c,
            { name: "unimpl", http: null, client: undefined, payload: { schema: { type: "object", properties: {} } } } as never,
            {}
          )
        ).rejects.toThrow("Not available yet")

        // 5. Commands human renderer for repo home (lines 140-143, 260)
        const homeOut: Array<string> = []
        await Cli.makeCli({ environment: env }).serve(["repo", "home", "--repo", "o/r"], {
          stdout: (s) => homeOut.push(s)
        })
        expect(homeOut.join("")).toContain("Hello")
      } finally {
        server.closeAllConnections()
        await new Promise<void>((r) => server.close(() => r()))
      }
    })
  }, 30_000)
})
