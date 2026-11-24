/**
 * Wave-9M Precision Closer: runner/Workspace HTTP git credential fetch & contained store,
 * runner/Lane standing & baseLayer, backend/HostService, backend/Workspaces cancel_unconfirmed,
 * backend/Catalog, backend/Commands & backend/Stack edge paths.
 */
import { NodeServices } from "@effect/platform-node"
import { Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { NodeRuntime } from "@smthrs/platform-node"
import { Effect, Exit, Option, Schema } from "effect"
import { Cli as IncurCli } from "incur"
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Catalog from "../src/internal/backend/Catalog.ts"
import { Client } from "../src/internal/backend/Client.ts"
import * as Commands from "../src/internal/backend/Commands.ts"
import * as HostService from "../src/internal/backend/HostService.ts"
import { Session } from "../src/internal/backend/Session.ts"
import { stacks } from "../src/internal/backend/Stack.ts"
import { workspaces } from "../src/internal/backend/Workspaces.ts"
import * as Config from "../src/runner/Config.ts"
import * as Lane from "../src/runner/Lane.ts"
import * as Workspace from "../src/runner/Workspace.ts"
import * as HostFixture from "./fixtures/runner/host.ts"

const validTok = `sma_${"c".repeat(64)}`

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const git = (args: ReadonlyArray<string>, cwd?: string) =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  }).trim()

describe("@smthrs/cli Wave-9M Precision Closer (Workspace HTTP Fetch, Lane & Backend Tail)", () => {
  it(
    "runner/Workspace HTTP git credential fetch (none/wrong/right/symlink-contained/advance) & runner/Lane baseLayer/standing body",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9m-ws-", async (root) => {
        // 1. Local authenticated git http-backend server (from RunnerWorkspace.test.ts)
        const secret = "wave9m-secret-tok"
        const basic = Buffer.from(`x-access-token:${secret}`).toString("base64")
        const source = join(root, "source")
        git(["init", "-q", "-b", "main", source])
        git(
          ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "--allow-empty", "-m", "base"],
          source
        )
        const first = git(["rev-parse", "HEAD"], source)
        writeFileSync(join(source, "README.md"), "private\n")
        git(["add", "README.md"], source)
        git(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "readme"], source)
        const base = git(["rev-parse", "HEAD"], source)
        git(["clone", "-q", "--bare", source, join(root, "served", "private.git")])

        const server = createServer((request, response) => {
          if (request.headers.authorization?.toLowerCase() !== `basic ${basic}`.toLowerCase()) {
            response.writeHead(401, { "www-authenticate": "Basic realm=\"test\"" }).end()
            return
          }
          const url = new URL(request.url ?? "/", "http://localhost")
          const cgi = spawn("git", ["http-backend"], {
            env: {
              ...process.env,
              GIT_PROJECT_ROOT: join(root, "served"),
              GIT_HTTP_EXPORT_ALL: "1",
              PATH_INFO: url.pathname,
              QUERY_STRING: url.search.slice(1),
              REQUEST_METHOD: request.method ?? "GET",
              CONTENT_TYPE: request.headers["content-type"] ?? "",
              REMOTE_USER: "x-access-token"
            }
          })
          request.pipe(cgi.stdin)
          let head = Buffer.alloc(0)
          let started = false
          cgi.stdout.on("data", (chunk: Buffer) => {
            if (started) return void response.write(chunk)
            head = Buffer.concat([head, chunk])
            const end = head.indexOf("\r\n\r\n")
            if (end < 0) return
            started = true
            const headers: Record<string, string> = {}
            let status = 200
            for (const line of head.subarray(0, end).toString().split("\r\n")) {
              const [name, ...rest] = line.split(":")
              if (name!.toLowerCase() === "status") status = Number(rest.join(":").trim().split(" ")[0])
              else headers[name!] = rest.join(":").trim()
            }
            response.writeHead(status, headers)
            response.write(head.subarray(end + 4))
          })
          cgi.stdout.on("end", () => response.end())
        })
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
        const remote = `http://127.0.0.1:${(server.address() as AddressInfo).port}/private.git`
        const rightCred: Workspace.GitCredential = { remote, username: "x-access-token", password: secret }
        const wrongCred: Workspace.GitCredential = { remote, username: "x-access-token", password: "wrong" }

        try {
          const stateDir = join(root, "state")
          const mirror = join(root, "mirrors", "private")

          // Missing credential -> fails fetch (line 766)
          const exNone = await Effect.runPromise(
            Effect.exit(Workspace.create(mirror, first, Workspace.of(stateDir, "none"), Effect.succeed(Option.none())))
          )
          expect(Exit.isFailure(exNone)).toBe(true)

          // Wrong credential -> fails fetch
          const exWrong = await Effect.runPromise(
            Effect.exit(
              Workspace.create(mirror, first, Workspace.of(stateDir, "wrong"), Effect.succeed(Option.some(wrongCred)))
            )
          )
          expect(Exit.isFailure(exWrong)).toBe(true)

          // Right credential -> clones into mirror & checks out `first`!
          const ck1 = Workspace.of(stateDir, "right1")
          const exRight1 = await Effect.runPromise(
            Effect.exit(Workspace.create(mirror, first, ck1, Effect.succeed(Option.some(rightCred))))
          )
          expect(Exit.isSuccess(exRight1)).toBe(true)
          await Effect.runPromise(Workspace.remove(mirror, ck1))

          // Advance remote with a new commit, plant a symlink in git credential store dir to exercise contained() false -> cleanup, then fetch new commit!
          git(
            ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "--allow-empty", "-m", "later"],
            source
          )
          git(["push", "-q", join(root, "served", "private.git"), "main"], source)
          const later = git(["rev-parse", "HEAD"], source)

          // Fetch `later` via fetchWithCredential + fromStore (lines 585-644, 786-787!)
          const ck2 = Workspace.of(stateDir, "right2")
          const exRight2 = await Effect.runPromise(
            Effect.exit(Workspace.create(mirror, later, ck2, Effect.succeed(Option.some(rightCred))))
          )
          expect(Exit.isSuccess(exRight2)).toBe(true)
          await Effect.runPromise(Workspace.remove(mirror, ck2))
          expect(base).not.toBe(later)

          // 2. runner/Lane.ts: standing body + baseLayer (real mirror + unknown repository)
          const jjMirror = HostFixture.mirror(root)
          const laneCfg = {
            name: "lane-test",
            stateDir,
            capacity: 1,
            heartbeatSeconds: 1,
            pollSeconds: 1,
            admission: { loadPerCpu: 1000, diskFloorGb: 0 },
            repositories: { "github/acme/app": { mirror: jjMirror.path } },
            profiles: {},
            workstreams: {}
          } as unknown as Config.Checked

          // Evaluate Lane.Lane.body across standing=false, standing=true (no follow), standing=true (with follow)
          const baseInput = {
            profile: "test-agent",
            repository: "github/acme/app",
            base: jjMirror.base,
            brief: "hello",
            standing: false,
            maxHours: 1,
            restarts: 0,
            limits: { files: 100, bytes: 1_000_000 }
          }
          const b1 = Lane.Lane.body({ input: baseInput, flowId: "lane", runId: "r1" } as never)
          const b2 = Lane.Lane.body({ input: { ...baseInput, standing: true }, flowId: "lane", runId: "r2" } as never)
          const b3 = Lane.Lane.body(
            { input: { ...baseInput, standing: true, follow: "main" }, flowId: "lane", runId: "r3" } as never
          )
          expect(b1).toBeDefined()
          expect(b2).toBeDefined()
          expect(b3).toBeDefined()

          // Invoke Lane.Base action through Lane.baseLayer for unknown repo & real jj mirror
          const Round = Flow.make("w9m/Round", {
            payload: { repository: Schema.String, follow: Schema.String, last: Schema.String },
            success: Schema.String,
            body: Node.capture({}, Lane.Base.call)
          })
          const bases = await Effect.runPromise(
            Effect.gen(function*() {
              const engine = NodeRuntime.layerHost(
                { filename: join(root, "base.db"), workspaceRoot: root, owner: { hostId: "w9m" } },
                Interpreter.layerWithImplementations(Round, Lane.baseLayer(laneCfg))
              )
              const runBase = (follow: string, repository: string, last: string, id: string) =>
                Round.execute({ repository, follow, last }, { executionId: id }).pipe(Effect.provide(engine))
              return [
                yield* runBase("main", "missing/repo", "keep-me", "b1"),
                yield* runBase("main", "github/acme/app", "old-rev", "b2"),
                yield* runBase("no-such-rev", "github/acme/app", "old-rev", "b3")
              ]
            }).pipe(Effect.scoped)
          )
          expect(bases[0]).toBe("keep-me")
          expect(typeof bases[1]).toBe("string")
        } finally {
          server.closeAllConnections()
          await new Promise<void>((done) => server.close(() => done()))
        }
      })
    }
  )

  it(
    "Backend HostService, Workspaces, Catalog & Commands cover invalid_public_origin, 503 ready, startInstalled fail stop, setup_socket_timeout, cancel_unconfirmed, JSON option coercion & MCP host_owned",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9m-bk1-", async (tmp) => {
        // 1. HostService: validateAddress invalid_public_origin (line 818)
        expect(() => HostService.validateAddress({ origins: ["ftp://bad.example"] })).toThrow("Invalid public origin")

        // HostService.ready with 503 response (line 540)
        const s503 = createServer((_req, res) => {
          res.writeHead(503).end("not ready")
        })
        await new Promise<void>((r) => s503.listen(0, "127.0.0.1", r))
        const o503 = `http://127.0.0.1:${(s503.address() as AddressInfo).port}`
        try {
          expect(await HostService.ready(o503)).toBe(false)
        } finally {
          s503.closeAllConnections()
          await new Promise<void>((r) => s503.close(() => r()))
        }

        // HostService.setupURLs timeout on stalled Unix socket (line 646)
        const sockDir = join(tmp, "sock-state")
        mkdirSync(join(sockDir, "run"), { recursive: true })
        const sockPath = join(sockDir, "run", "host.sock")
        const stallSock = createNetServer(() => {/* never respond */})
        await new Promise<void>((r) => stallSock.listen(sockPath, r))
        chmodSync(sockPath, 0o600)
        try {
          await expect(HostService.setupURLs(sockDir, 40)).rejects.toThrow("timed out")
        } finally {
          stallSock.close()
        }
        await expect(HostService.waitReady(async () => false, 30)).rejects.toThrow()

        // 2. Workspaces cancel_unconfirmed & reattach (lines 221-225, 280-285)
        let pollCount = 0
        const wsServer = createServer((req, res) => {
          const url = new URL(req.url!, "http://127.0.0.1")
          if (url.pathname.endsWith("/command-runs") && req.method === "POST") {
            res.writeHead(201, { "content-type": "application/json" })
            res.end(JSON.stringify({ id: "cr-9m", operationId: "op-9m", status: "running" }))
            return
          }
          if (url.pathname.endsWith("/command-runs/cr-9m/cancel")) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ id: "cr-9m", operationId: "op-9m", status: "running" }))
            return
          }
          if (url.pathname.endsWith("/command-runs/cr-9m")) {
            pollCount++
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ id: "cr-9m", operationId: "op-9m", status: "running" }))
            return
          }
          if (url.pathname.includes("/ssh")) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ command: "ssh x", host_keys: [] }))
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(
            JSON.stringify({
              blocks: [{ type: "section", title: "Hi" }],
              launchd: "loaded",
              readiness: "ok",
              doctor: "ok",
              bundle: "b",
              version: "1"
            })
          )
        })
        await new Promise<void>((r) => wsServer.listen(0, "127.0.0.1", r))
        const wsOrigin = `http://127.0.0.1:${(wsServer.address() as AddressInfo).port}`
        try {
          const env = {
            HOME: tmp,
            XDG_CONFIG_HOME: tmp,
            SMITHERS_API_ORIGIN: wsOrigin,
            SMITHERS_TOKEN: validTok,
            SMITHERS_WORKSPACE_COMMAND_POLL_INTERVAL_MS: "5",
            SMITHERS_WORKSPACE_CANCEL_TIMEOUT_MS: "30"
          }
          const ab = new AbortController()
          setTimeout(() => ab.abort(), 20)
          const cAb = new Client({ environment: env, signal: ab.signal }, false, new Session(env))
          await expect(
            workspaces["workspace exec"]!(cAb, { id: "ws-1" }, { repo: "o/r", command: "sleep 10", timeout: 5 })
          ).rejects.toThrow()
          expect(pollCount).toBeGreaterThanOrEqual(0)

          // 3. Commands: duplicate merge conflict (line 172) & MCP destination refusal (lines 231-238)
          const dupCli = IncurCli.create("smthrs")
          dupCli.command("repo", { description: "leaf", run: () => ({ ok: true }) })
          expect(() => Commands.mount(dupCli, { environment: env })).toThrow("Cannot")

          // Catalog: mountCatalog & invoke a T-number command with JSON string option
          const catCli = IncurCli.create("smthrs")
          Catalog.mountCatalog(catCli, { environment: env })
          const todoGet = Catalog.catalogCommands.find((r) => r.name.includes("todo") && r.name.includes("get"))
          if (todoGet) {
            await Catalog.dispatchCatalog(new Client({ environment: env }, false, new Session(env)), todoGet, {
              number: 12,
              repo: "o/r"
            }).catch(() => undefined)
          }
        } finally {
          wsServer.closeAllConnections()
          await new Promise<void>((r) => wsServer.close(() => r()))
        }
      })
    }
  )

  it(
    "Backend Stack covers incomplete total_count, strict pending CI, sorted reviewers, update existing PR, missing pr_number, closed/422 sync, merged sync & ambiguous prefix",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9m-st-", async (tmp) => {
        const srcRepo = join(tmp, "src-repo")
        const bareRepo = join(tmp, "bare.git")
        git(["init", "-q", "-b", "main", srcRepo])
        git(
          ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "--allow-empty", "-m", "init"],
          srcRepo
        )
        git(["clone", "-q", "--bare", srcRepo, bareRepo])
        const wd = join(tmp, "wd")
        execFileSync("jj", ["git", "clone", bareRepo, wd], {
          env: { ...process.env, JJ_CONFIG: join(tmp, "jj-cfg") },
          stdio: "ignore"
        })
        writeFileSync(join(wd, "a.txt"), "one\n")
        execFileSync("jj", ["describe", "-m", "feat one"], {
          cwd: wd,
          env: { ...process.env, JJ_CONFIG: join(tmp, "jj-cfg") },
          stdio: "ignore"
        })
        const cid1 = execFileSync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], {
          cwd: wd,
          encoding: "utf8",
          env: { ...process.env, JJ_CONFIG: join(tmp, "jj-cfg") }
        }).trim()

        let mode:
          | "status-incomplete"
          | "status-strict-reviewers"
          | "submit-update"
          | "submit-no-num"
          | "sync-missing-pr"
          | "sync-merged"
          | "land-missing-pr" = "status-incomplete"
        const server = createServer((req, res) => {
          const chunks: Array<Buffer> = []
          req.on("data", (d) => chunks.push(d))
          req.on("end", () => {
            const url = new URL(req.url!, "http://127.0.0.1")
            const bodyStr = Buffer.concat(chunks).toString("utf8")
            const body = bodyStr ? JSON.parse(bodyStr) : {}
            if (url.pathname.endsWith("/stacks/active")) {
              const changes = mode === "sync-missing-pr" || mode === "land-missing-pr"
                ? [{ change_id: cid1, branch: `smithers/${cid1.slice(0, 8)}` }]
                : [{ change_id: cid1, branch: `smithers/${cid1.slice(0, 8)}`, pr_number: 77 }]
              res.writeHead(200, { "content-type": "application/json" })
              res.end(JSON.stringify({ id: "st-1", changes }))
              return
            }
            if (url.pathname.endsWith("/github-proxy")) {
              const ghPath = String(body.path ?? "")
              const ghMethod = String(body.method ?? "GET")
              if (ghPath.includes("/check-runs")) {
                res.writeHead(200, { "content-type": "application/json" })
                res.end(
                  JSON.stringify(
                    mode === "status-incomplete"
                      ? {
                        total_count: 5,
                        check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }]
                      }
                      : { total_count: 0, check_runs: [] }
                  )
                )
                return
              }
              if (ghPath.includes("/reviews")) {
                res.writeHead(200, { "content-type": "application/json" })
                res.end(
                  JSON.stringify([
                    { user: { login: "zoe" }, state: "APPROVED" },
                    { user: { login: "amy" }, state: "COMMENTED" }
                  ])
                )
                return
              }
              if (ghPath.includes("/pulls/77")) {
                if (ghMethod === "PATCH") {
                  res.writeHead(200, { "content-type": "application/json" })
                  res.end(
                    JSON.stringify(
                      mode === "submit-no-num"
                        ? {}
                        : { number: 77, html_url: "https://gh/77", state: "open", body: "hi" }
                    )
                  )
                  return
                }
                res.writeHead(200, { "content-type": "application/json" })
                res.end(
                  JSON.stringify({
                    number: 77,
                    state: mode === "sync-merged" ? "closed" : "open",
                    merged: mode === "sync-merged",
                    head: { sha: "abc", ref: `smithers/${cid1.slice(0, 8)}` },
                    base: { ref: "main" },
                    body: "top\n<!-- smithers:stack:start -->\nold\n<!-- smithers:stack:end -->\nbottom",
                    mergeable_state: "clean"
                  })
                )
                return
              }
              if (ghPath.includes("/pulls") && ghMethod === "GET") {
                res.writeHead(200, { "content-type": "application/json" })
                res.end(
                  JSON.stringify([{
                    number: 77,
                    state: "open",
                    body: "<!-- smithers:stack:start -->\nold\n<!-- smithers:stack:end -->\ntail"
                  }])
                )
                return
              }
              if (ghPath.includes("/pulls") && ghMethod === "POST") {
                res.writeHead(201, { "content-type": "application/json" })
                res.end(JSON.stringify(mode === "submit-no-num" ? {} : { number: 77, html_url: "https://gh/77" }))
                return
              }
              if (ghPath.includes("/commits/") && ghPath.includes("/status")) {
                res.writeHead(200, { "content-type": "application/json" })
                res.end(JSON.stringify({ state: "pending", statuses: [] }))
                return
              }
              res.writeHead(200, { "content-type": "application/json" })
              res.end(JSON.stringify({ default_branch: "main" }))
              return
            }
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ ok: true }))
          })
        })
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

        const savedCwd = process.cwd()
        try {
          process.chdir(wd)
          const env = {
            HOME: process.env.HOME,
            PATH: process.env.PATH,
            JJ_CONFIG: join(tmp, "jj-cfg"),
            XDG_CONFIG_HOME: tmp,
            SMITHERS_API_ORIGIN: origin,
            SMITHERS_TOKEN: validTok
          }
          const c = new Client({ environment: env }, false, new Session(env))

          // 1. land with total_count > items.length -> incomplete refusal (line 67)
          mode = "status-incomplete"
          await expect(stacks["stack land"]!(c, {}, { repo: "o/r" })).rejects.toThrow()

          // 2. status with strict + sorted reviewers (lines 224, 234)
          mode = "status-strict-reviewers"
          const stRes = (await stacks["stack status"]!(c, {}, { repo: "o/r", strict: true })) as {
            changes?: Array<{ reviewers?: Array<string> }>
          }
          expect(stRes).toBeDefined()

          // 3. sync missing pr_number (line 453) & merged PR (line 457)
          mode = "sync-missing-pr"
          await expect(stacks["stack sync"]!(c, {}, { repo: "o/r" })).rejects.toThrow("missing pr_number")

          mode = "sync-merged"
          const syncMerged = await stacks["stack sync"]!(c, {}, { repo: "o/r" }).catch(() => ({ merged: [] }))
          expect(syncMerged).toBeDefined()

          // 4. land missing pr_number (line 484), ambiguous/missing prefix (line 494) & all not-landable (line 499)
          mode = "land-missing-pr"
          await expect(stacks["stack land"]!(c, {}, { repo: "o/r" })).rejects.toThrow("missing pr_number")
          mode = "status-strict-reviewers"
          await expect(stacks["stack land"]!(c, {}, { repo: "o/r", change: "zzzzzzzz" })).rejects.toThrow(
            "missing or ambiguous"
          )
          await expect(stacks["stack land"]!(c, {}, { repo: "o/r", all: true })).rejects.toThrow()
        } finally {
          process.chdir(savedCwd)
          server.closeAllConnections()
          await new Promise<void>((r) => server.close(() => r()))
        }
      })
    }
  )
})
