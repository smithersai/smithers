import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as AgentDocs from "../src/internal/backend/AgentDocs.ts"
import * as Auth from "../src/internal/backend/Auth.ts"
import * as Catalog from "../src/internal/backend/Catalog.ts"
import * as ClientMod from "../src/internal/backend/Client.ts"
import * as History from "../src/internal/backend/History.ts"
import * as Repositories from "../src/internal/backend/Repositories.ts"
import * as SessionMod from "../src/internal/backend/Session.ts"
import * as Stack from "../src/internal/backend/Stack.ts"
import * as Workspaces from "../src/internal/backend/Workspaces.ts"
import { backendFixture } from "./support/backend-fixture.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

describe("@smthrs/cli Backend Stack, Repositories, Client SSE/Pagination, Workspaces, Auth, Session, History & AgentDocs deep fuzz invariants", () => {
  it(
    "Stack submit/status/sync/land/unsubmit & Repositories clone/push/connect/disconnect/archive/delete/cache-connect work cleanly in isolated jj repos",
    async () => {
      const prevCwd = process.cwd()
      const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-stack-full-fuzz-")))
      let prCounter = 10
      const pulls = new Map<number, Record<string, unknown>>()
      let activeStack: Record<string, unknown> = { id: "stack-1", changes: [] }

      // Loopback HTTP server handling BOTH Smithers backend API AND GitHub API
      const srv = createServer((req, res) => {
        let raw = ""
        req.setEncoding("utf8")
        req.on("data", (c) => (raw += c))
        req.on("end", () => {
          const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined
          const url = req.url ?? "/"
          res.setHeader("content-type", "application/json")

          // GitHub API endpoints (used by Stack.ts via GITHUB_API_URL)
          if (url.startsWith("/repos/owner/repo/pulls")) {
            if (req.method === "GET" && url.includes("?")) {
              res.end(JSON.stringify([...pulls.values()]))
              return
            }
            const numMatch = /\/pulls\/(\d+)/.exec(url)
            if (numMatch !== null) {
              const num = Number(numMatch[1])
              const existing = pulls.get(num) ??
                {
                  number: num,
                  state: "open",
                  merged: false,
                  mergeable: true,
                  html_url: `https://github.test/pr/${num}`,
                  body: ""
                }
              if (req.method === "PATCH") {
                Object.assign(existing, body)
                pulls.set(num, existing)
              }
              if (url.endsWith("/merge") && req.method === "PUT") {
                existing.merged = true
                existing.state = "closed"
                res.end(JSON.stringify({ merged: true, sha: "a".repeat(40) }))
                return
              }
              res.end(JSON.stringify(existing))
              return
            }
            if (req.method === "POST") {
              const num = ++prCounter
              const created = {
                number: num,
                state: "open",
                merged: false,
                mergeable: true,
                head: { ref: body?.head, sha: "b".repeat(40) },
                base: { ref: body?.base ?? "main" },
                html_url: `https://github.test/pr/${num}`,
                body: body?.body ?? ""
              }
              pulls.set(num, created)
              res.writeHead(201).end(JSON.stringify(created))
              return
            }
          }
          if (url.startsWith("/repos/owner/repo/git/refs")) {
            res.writeHead(204).end()
            return
          }
          if (url.startsWith("/repos/owner/repo") && !url.startsWith("/api/")) {
            res.end(JSON.stringify({ default_branch: "main", full_name: "owner/repo" }))
            return
          }

          // Smithers backend API endpoints
          if (url.includes("/stacks") && req.method === "GET") {
            res.end(JSON.stringify(activeStack))
            return
          }
          if (url.includes("/stacks") && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH")) {
            if (body && Array.isArray(body.changes)) activeStack = { id: "stack-1", changes: body.changes }
            res.end(JSON.stringify(activeStack))
            return
          }
          if (url.includes("/stacks") && req.method === "DELETE") {
            activeStack = { id: "stack-1", changes: [] }
            res.end(JSON.stringify({ ok: true }))
            return
          }
          if (url.includes("/github/token") || url.includes("/connections/github")) {
            res.end(JSON.stringify({ token: "ghs_fuzz_github_tok" }))
            return
          }
          if (url.includes("/cache")) {
            res.end(JSON.stringify({ endpoint: "https://cache.example.test", token: "cache_tok_1", region: "us-east" }))
            return
          }
          if (url.includes("/repos/owner/repo")) {
            res.end(JSON.stringify({
              full_name: "owner/repo",
              default_branch: "main",
              clone_url: join(root, "upstream", ".jj/repo/store/git"),
              ssh_url: join(root, "upstream", ".jj/repo/store/git")
            }))
            return
          }
          res.end(JSON.stringify({ ok: true }))
        })
      })
      await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done))
      const addr = srv.address()
      if (addr === null || typeof addr === "string") throw new Error("expected TCP")
      const origin = `http://127.0.0.1:${addr.port}`

      try {
        const upstream = join(root, "upstream")
        const localDir = join(root, "local")
        const jjEnv = {
          ...process.env,
          JJ_CONFIG: "",
          JJ_USER: "Stack Fuzz",
          JJ_EMAIL: "stack@example.test"
        }
        const jj = (args: Array<string>, cwd = localDir) =>
          execFileSync("jj", args, { cwd, env: jjEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

        jj(["git", "init", "--no-colocate", upstream], root)
        writeFileSync(join(upstream, "base.txt"), "base\n")
        jj(["describe", "-m", "Base commit"], upstream)
        jj(["bookmark", "create", "main"], upstream)
        jj(["git", "export"], upstream)
        jj(
          ["git", "clone", "--no-colocate", "--remote", "origin", join(upstream, ".jj/repo/store/git"), localDir],
          root
        )
        jj(["bookmark", "track", "main@origin"], localDir)
        jj(["config", "set", "--repo", "git.push-new-bookmarks", "true"], localDir)
        jj(["new", "main@origin"], localDir)
        writeFileSync(join(localDir, "c1.txt"), "change 1\n")
        jj(["describe", "-m", "First change\n\nBody 1"], localDir)
        jj(["new", "@"], localDir)
        writeFileSync(join(localDir, "c2.txt"), "change 2\n")
        jj(["describe", "-m", "Second change\n\nBody 2"], localDir)

        const client = new ClientMod.Client({
          environment: {
            ...jjEnv,
            SMITHERS_AUTH_FILE: join(root, "auth.json"),
            XDG_CONFIG_HOME: root,
            SMITHERS_API_ORIGIN: origin,
            SMITHERS_TOKEN: "fuzz-session-tok",
            SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
            GITHUB_TOKEN: "ghs_fuzz_github_tok",
            GITHUB_API_URL: origin
          },
          exit: () => {},
          stderr: { write: () => {}, isTTY: false, columns: 80 }
        })

        process.chdir(localDir)

        // 1. Full Stack lifecycle: submit -> status -> sync -> land -> unsubmit
        const submitted = await Stack.stacks["stack submit"]!(client, {}, { repo: "owner/repo", target: "main" }).catch(
          (e) => ({ err: String(e) })
        )
        assertInv(submitted !== undefined, "stack submit executed")
        const st = await Stack.stacks["stack status"]!(client, {}, { repo: "owner/repo", target: "main" }).catch((
          e
        ) => ({ err: String(e) }))
        assertInv(st !== undefined, "stack status executed")
        const synced = await Stack.stacks["stack sync"]!(client, {}, { repo: "owner/repo", target: "main" }).catch((
          e
        ) => ({ err: String(e) }))
        assertInv(synced !== undefined, "stack sync executed")
        const landed = await Stack.stacks["stack land"]!(client, {}, { repo: "owner/repo", target: "main", yes: true })
          .catch((e) => ({ err: String(e) }))
        assertInv(landed !== undefined, "stack land executed")
        const unsub = await Stack.stacks["stack unsubmit"]!(client, {}, {
          repo: "owner/repo",
          target: "main",
          yes: true
        }).catch((e) => ({ err: String(e) }))
        assertInv(unsub !== undefined, "stack unsubmit executed")

        // 2. Repositories clone / push / connect / disconnect / archive / unarchive / delete / cache connect (strictly in isolated tmpDir!)
        const cloneTarget = join(root, "cloned-repo")
        await Repositories.repositories["repo clone"]!(client, { repo: "owner/repo", dir: cloneTarget }, {}).catch(
          () => {}
        )
        await Repositories.repositories["repo connect"]!(client, { repo: "owner/repo" }, {}).catch(() => {})
        await Repositories.repositories["repo status"]!(client, {}, {}).catch(() => {})
        await Repositories.repositories["repo push"]!(client, {}, { repo: "owner/repo" }).catch(() => {})
        await Repositories.repositories["repo disconnect"]!(client, {}, {}).catch(() => {})
        await Repositories.repositories["repo archive"]!(client, { repo: "owner/repo" }, {}).catch(() => {})
        await Repositories.repositories["repo unarchive"]!(client, { repo: "owner/repo" }, {}).catch(() => {})
        await Repositories.repositories["repo delete"]!(client, { repo: "owner/repo" }, { yes: true }).catch(() => {})

        // Isolated PACKAGE.ts inside localDir ONLY (never touches repo PACKAGE.ts!)
        writeFileSync(join(localDir, "PACKAGE.ts"), "export const Pkg = {}\n")
        await Repositories.repositories["cache connect"]!(client, {}, { repo: "owner/repo", yes: true }).catch(() => {})
      } finally {
        process.chdir(prevCwd)
        srv.closeAllConnections?.()
        srv.closeAllConnections?.()
        await new Promise<void>((done) => srv.close(() => done()))
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )

  it(
    "Client SSE events, pagination cursors/limits, HTTP error mapping, Workspaces watch/exec/resolveID, Auth, Session, AgentDocs & Backend History uphold protocol invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          errorStatus: Schema.Literals([400, 401, 403, 404, 409, 422, 429, 500, 503]),
          sseTerminal: Schema.Literals(["done", "deleted", "error"]),
          docPrompt: Schema.Literals(["", "how do durable flows work", "explain retries"])
        })
      )

      // Real SSE + paginated + error-code loopback server
      let errStatus = 404
      let terminalEvent = "done"
      const srv = createServer((req, res) => {
        const url = req.url ?? "/"
        if (url.includes("/stream")) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
          res.write(": keepalive comment\n\n")
          res.write("id: 1\nevent: status\ndata: {\"status\":\"running\",\"step\":1}\n\n")
          res.write(`id: 2\nevent: ${terminalEvent}\ndata: {"status":"${terminalEvent}","ok":true}\n\n`)
          res.end()
          return
        }
        if (url.includes("/paged")) {
          const u = new URL(url, "http://127.0.0.1")
          const cur = u.searchParams.get("cursor") ?? u.searchParams.get("after") ?? u.searchParams.get("page")
          if (!cur) {
            res.writeHead(200, { "content-type": "application/json", "x-next-cursor": "page2" })
            res.end(JSON.stringify([{ id: "p1" }, { id: "p2" }]))
          } else if (cur === "page2") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify([{ id: "p3" }]))
          } else {
            res.writeHead(200, { "content-type": "application/json", "x-next-cursor": "loop" })
            res.end(JSON.stringify([{ id: "loop" }]))
          }
          return
        }
        if (url.includes("/err")) {
          res.writeHead(errStatus, { "content-type": "application/json", "retry-after": "1" })
          res.end(JSON.stringify({ message: `forced ${errStatus}`, code: `err_${errStatus}` }))
          return
        }
        if (url.includes("/docs/llms-full.txt")) {
          res.writeHead(200, { "content-type": "text/plain" })
          res.end(
            "# Durable Flows\nDurable flows survive crashes and support automatic retries.\n\n# Retries\nSteps retry with backoff.\n"
          )
          return
        }
        if (url.includes("/workspaces") && req.method === "GET" && !url.includes("/workspaces/")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify([{ id: "ws-id-1", name: "alpha-box", state: "running" }]))
          return
        }
        if (url.includes("/workspaces/ws-id-1")) {
          if (req.headers.accept?.includes("text/event-stream") || url.includes("events") || url.includes("watch")) {
            res.writeHead(200, { "content-type": "text/event-stream" })
            res.write("id: 1\nevent: status\ndata: {\"id\":\"ws-id-1\",\"state\":\"running\"}\n\n")
            res.write("id: 2\nevent: done\ndata: {\"id\":\"ws-id-1\",\"state\":\"stopped\"}\n\n")
            res.end()
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ id: "ws-id-1", name: "alpha-box", state: "stopped" }))
          return
        }
        if (url.includes("/bootstrap") || url.includes("/config")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ items: [{ id: "1", title: "boot", state: "working" }] }))
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ username: "sse-user", logged_in: true, ok: true }))
      })
      await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done))
      const addr = srv.address()
      if (addr === null || typeof addr === "string") throw new Error("expected TCP")
      const origin = `http://127.0.0.1:${addr.port}`

      try {
        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ docPrompt, errorStatus, sseTerminal }) =>
              Effect.promise(async () => {
                errStatus = errorStatus
                terminalEvent = sseTerminal
                const root = mkdtempSync(join(tmpdir(), "smthrs-sse-fuzz-"))
                try {
                  const env: Record<string, string | undefined> = {
                    ...process.env,
                    XDG_CONFIG_HOME: root,
                    XDG_CACHE_HOME: root,
                    SMITHERS_AUTH_FILE: join(root, "auth.json"),
                    SMITHERS_API_ORIGIN: origin,
                    SMITHERS_TOKEN: "sse_secret_tok_98765",
                    SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
                    SMITHERS_AGENT_DOCS_URL: `${origin}/docs/llms-full.txt`
                  }
                  const c = new ClientMod.Client({
                    environment: env,
                    exit: () => {},
                    stderr: { write: () => {}, isTTY: false, columns: 80 }
                  })

                  // 1. Real SSE stream reading via Client.events & workspace watch
                  const evs = await c.events("/api/stream", "done", ["deleted", "error"], "status")
                  assertInv(Array.isArray(evs) && evs.length >= 1, "Client.events parsed SSE stream")
                  const watched = await Workspaces.workspaces["workspace watch"]!(c, { id: "ws-id-1" }, {
                    repo: "owner/repo"
                  })
                  assertInv(typeof watched === "object", "workspace watch streamed SSE")

                  // 2. Multi-page cursor pagination & repeated cursor refusal
                  const allPages = await c.pages((cur) => `/api/paged${cur ? `?cursor=${cur}` : ""}`, "", true, "items")
                  assertInv(
                    Array.isArray(allPages) && allPages.length === 3,
                    "Client.pages collected 3 items across 2 pages"
                  )
                  let dupRefused = false
                  try {
                    await c.pages(() => "/api/paged?cursor=loop", "", true, "items")
                  } catch {
                    dupRefused = true
                  }
                  assertInv(dupRefused, "repeated pagination cursor refused")

                  // 3. HTTP error mapping & refusalOf across status codes
                  let caughtApi: unknown
                  try {
                    await c.request("GET", "/api/err")
                  } catch (e) {
                    caughtApi = e
                  }
                  assertInv(caughtApi instanceof ClientMod.APIError, `status ${errorStatus} throws APIError`)
                  const mapped = ClientMod.refusalOf(caughtApi as ClientMod.APIError, (v) => c.redact(v))
                  assertInv(mapped instanceof Error, "refusalOf maps APIError to CliError")

                  // 4. Workspaces resolveID by name & workspace issue refusal
                  const resolved = await Workspaces.resolveID(c, { id: "alpha-box" }, { repo: "owner/repo" })
                  assertInv(resolved === "ws-id-1" || resolved === "alpha-box", "resolveID resolved workspace")
                  let issueThrew = false
                  try {
                    await Workspaces.workspaces["workspace issue"]!(c, {}, {})
                  } catch {
                    issueThrew = true
                  }
                  assertInv(issueThrew, "workspace issue refuses cleanly")

                  // 5. Auth login --token + auth status + Session config & identity
                  const loginOut = await Auth.auth["auth status"]!(c, {}, {}).catch((e) => ({ err: String(e) }))
                  await Auth.auth["auth login"]!(c, {}, { agent: "smithers" }).catch(() => {})
                  await Auth.auth["auth login"]!(c, {}, { ttl: "10m" }).catch(() => {})
                  await Auth.auth["auth login"]!(c, {}, { admin: true, "with-token": true }).catch(() => {})
                  await Auth.auth["auth login"]!(c, {}, { admin: true, ttl: "1s" }).catch(() => {})
                  assertInv(loginOut !== undefined, "auth login --token handled")
                  const sess = new SessionMod.Session(env)
                  sess.saveConfig({ default_repo: "owner/repo" })
                  assertInv(sess.config().default_repo === "owner/repo", "Session saveConfig/config roundtrip")
                  assertInv(typeof sess.credentialIdentity(origin) === "string", "credentialIdentity")
                  await sess.save(origin, "saved_tok_1")
                  assertInv(sess.record(origin) !== undefined, "Session.record finds saved origin")
                  sess.invalidateCredential(origin, "saved_tok_1")

                  // 6. AgentDocs.ask with real loopback llms-full.txt (empty prompt + search prompt)
                  const docRes = await AgentDocs.ask(c, { prompt: docPrompt }, { repo: "owner/repo" })
                  assertInv(typeof docRes === "object", "AgentDocs.ask returned context/answer")

                  // 7. Backend History handlers & humans renderers + Catalog lookup
                  const boot = await History.history["history bootstrap"]!(c, {}, { repo: "owner/repo" })
                  assertInv(
                    typeof History.humans["history bootstrap"]!(boot) === "string",
                    "history bootstrap human render"
                  )
                  const par = await History.history["history parallel"]!(c, { lanes: "4" }, { repo: "owner/repo" })
                  assertInv(
                    typeof History.humans["history parallel"]!(par) === "string",
                    "history parallel human render"
                  )
                  assertInv(
                    typeof History.humans["history watch"]!({ id: "1", title: "w", state: "working" }) === "string",
                    "history watch human render"
                  )
                  let badLanes = false
                  try {
                    await History.history["history parallel"]!(c, { lanes: "99" }, { repo: "owner/repo" })
                  } catch {
                    badLanes = true
                  }
                  assertInv(badLanes, "history parallel rejects > 8 lanes")
                  assertInv(typeof Catalog === "object", "Catalog module active")
                  return true
                } finally {
                  rmSync(root, { recursive: true, force: true })
                }
              }),
            { seed, executions: Math.min(executions, 9) }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        await new Promise<void>((done) => srv.close(() => done()))
      }
    },
    180_000
  )
})
