import { ImmutableCache } from "@smthrs/artifacts"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { createServer, type ServerResponse } from "node:http"
import { once } from "node:events"
import { type AddressInfo } from "node:net"
import { afterEach, expect, test } from "vitest"
import { Scratch } from "../../db/TestDatabase.ts"
import * as Repos from "../Repos.ts"
import * as RepoReads from "../RepoReads.ts"
import { repositoryOf } from "../github/Config.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import { scripted } from "../test/codeStorage.ts"
import { testFile } from "../test/harness.ts"
import { makeMcpAuthService } from "./Auth.ts"
import { McpAuthService, type McpPrincipal } from "./Contract.vibe"
import { makeLiveDeps } from "./LiveDeps.ts"
import { makeLiveToolDeps, makeMcpToolRegistry, MAX_FILE_PREVIEW_BYTES } from "./Tools.ts"

const runtime = testFile("mcp_repository_reads")
const sha = "a".repeat(40)
const repo = { owner: "acme", name: "project" }
const repoScope = "github/acme/project"
const origin = "http://localhost"
const stops: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of stops.splice(0)) await close() })

const harness = async (handle: (url: URL, res: ServerResponse) => void) => {
  const server = createServer((req, res) => handle(new URL(req.url!, origin), res))
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  stops.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }))
  const { database } = await runtime.runPromise(Effect.service(Scratch))
  // Only the missing mirror is injected. Authorization, cache, HTTP and the local projection are live.
  const reads = RepoReads.make({ database, codeStorage: scripted().client, budgets: await runtime.runPromise(Repos.budgets), maxTreePaths: 100, maxRefs: 100 })
  const deps = await Effect.runPromise(makeLiveDeps({
    database, reads: Option.some(reads), repoCache: ImmutableCache.layerMemory(),
    starter: { start: () => Effect.die("read started a write") },
    githubFallbackClient: await Effect.runPromise(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))),
    githubApiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  }))
  return { database, deps }
}

const json = (response: ServerResponse, data: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data))

test("an absent mirror falls back at a branch and at its exact commit", async () => {
  const { deps } = await harness((url, res) => {
    if (url.pathname.includes("/git/trees/")) return void json(res, { sha, tree: [{ type: "blob", path: "README" }] })
    if (url.pathname.endsWith("/contents/README")) return void res.end("contents")
    res.writeHead(404).end()
  })
  for (const ref of ["main", sha]) {
    expect(await Effect.runPromise(deps.readTree(repo.owner, repo.name, ref))).toEqual({ ref: sha, paths: ["README"], truncated: false })
    expect(await Effect.runPromise(deps.readFile(repo.owner, repo.name, "README", ref))).toEqual({ path: "README", ref, content: "contents" })
    expect(await Effect.runPromise(Effect.flip(deps.readFile(repo.owner, repo.name, "absent", ref)))).toMatchObject({ code: "not_found" })
  }
})

test("private reads require read consent and pinned credentials cannot enter fleet tools", async () => {
  const { deps, database } = await harness((_url, res) => { res.end("contents") })
  const personId = crypto.randomUUID()
  const roles = await Effect.runPromise(RepoRoles.make(database, { repository: repositoryOf("acme/project"), app: Option.none() }))
  const auth = await Effect.runPromise(makeMcpAuthService({ database, roles }))
  const fleet = { database, admins: new Set(["admin"]) }
  const live = makeLiveToolDeps({ ...deps, fleet })
  expect(live.fleet).toBe(fleet)
  const registry = await Effect.runPromise(makeMcpToolRegistry(live).pipe(Effect.provide(Layer.succeed(McpAuthService, auth))))
  const token = (scope: "mcp:read" | "mcp:write"): McpPrincipal => ({
    tokenId: "test", personId, login: "admin", clientName: "test", repoScope, scopes: [scope],
    actor: { subject: { kind: "person", id: personId }, role: "member", act: { kind: "agent", id: "mcp:test" } },
  })
  const ctx = (principal: Option.Option<McpPrincipal>) => ({ principal, defaultRepo: repo, origin, requestId: "1" })
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient))
  await runtime.runPromise(sql`INSERT INTO people (id, github_id, github_login) VALUES (${personId}::uuid, 199, 'admin')`)
  await runtime.runPromise(sql`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at)
    VALUES (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${personId}::uuid, 'member', now(), now(), now() + interval '1 day')`)
  await runtime.runPromise(sql`INSERT INTO github_repositories (repo_id, private, visibility_verified_at) VALUES (${repoScope}, true, now())`)
  expect(await Effect.runPromise(registry.listTools(Option.none(), repo))).toEqual([])
  const writeOnly = Option.some(token("mcp:write"))
  const readOnly = Option.some(token("mcp:read"))
  for (const name of ["repo_read_file", "todo_list"]) {
    const args = name === "repo_read_file" ? { path: "README", ref: sha } : {}
    expect(await Effect.runPromise(Effect.flip(registry.callTool(name, args, ctx(writeOnly))))).toMatchObject({ code: "forbidden" })
    expect((await Effect.runPromise(registry.callTool(name, args, ctx(readOnly)))).content.length).toBeGreaterThan(0)
  }
  const catalog = await Effect.runPromise(registry.listTools(writeOnly, repo))
  expect(catalog.some(t => t.name.startsWith("fleet_") || t.name === "todo_draft" || t.name === "repo_read_file")).toBe(false)
  expect(await Effect.runPromise(Effect.flip(registry.callTool("todo_draft", { title: "Task", prompt: "Do it" }, ctx(writeOnly)))))
    .toMatchObject({ code: "unavailable" })
  for (const name of ["fleet_overview", "fleet_heartbeat"]) {
    expect(await Effect.runPromise(Effect.flip(registry.callTool(name, {}, ctx(writeOnly))))).toMatchObject({ code: "forbidden" })
  }
  await runtime.runPromise(sql`UPDATE github_repositories SET private = false WHERE repo_id = ${repoScope}`)
  const result = await Effect.runPromise(registry.callTool("repo_read_file", { path: "README", ref: sha }, ctx(Option.none())))
  expect(result.content.at(-1)?.text).toContain("contents")
})

test.each(["git/ref/heads/main", "branches", "tags", "issues/1/comments", "pulls/1/reviews"])("secondary failure from %s survives the read", async suffix => {
  const { deps } = await harness((url, res) => {
    if (url.pathname.endsWith(suffix)) return void res.writeHead(429).end()
    if (url.pathname.endsWith("/project")) return void json(res, { default_branch: "main" })
    if (url.pathname.endsWith("/main")) return void json(res, { object: { sha } })
    json(res, url.pathname.endsWith("/1") ? { number: 1 } : [])
  })
  const read = suffix.includes("comments") ? deps.getIssue(repo.owner, repo.name, 1)
    : suffix.includes("reviews") ? deps.getPull(repo.owner, repo.name, 1) : deps.listRefs(repo.owner, repo.name)
  const failure = await Effect.runPromise(Effect.flip(read as Effect.Effect<unknown, import("./Contract.vibe").McpToolError>))
  expect(failure.code).toBe("rate_limited")
})

test("unsynced issues continue through PR-only pages and validate their continuation", async () => {
  const { deps } = await harness((url, res) => {
    if (url.searchParams.get("page") === "1") {
      res.setHeader("link", '<https://api.github.com/page2>; rel="next"')
      json(res, [{ number: 1, title: "target", pull_request: {} }])
    } else json(res, [{ number: 2, title: "first target" }, { number: 3, title: "second target" }])
  })
  const query = { state: "open" as const, q: "target", limit: 1 }
  const first = await Effect.runPromise(deps.listIssues(repo.owner, repo.name, query))
  expect(first.issues.map(i => i.number)).toEqual([2])
  expect(first.nextCursor).toEqual(expect.any(String))
  const next = { ...query, cursor: first.nextCursor! }
  const second = await Effect.runPromise(deps.listIssues(repo.owner, repo.name, next))
  expect(second.issues.map(i => i.number)).toEqual([3])
  expect(second.nextCursor).toBeNull()
  for (const mismatch of [{ ...next, q: "" }, { ...next, state: "closed" as const }]) {
    expect(await Effect.runPromise(Effect.flip(deps.listIssues(repo.owner, repo.name, mismatch)))).toMatchObject({ code: "invalid_params" })
  }
  expect(await Effect.runPromise(Effect.flip(deps.listIssues(repo.owner, "other", next)))).toMatchObject({ code: "invalid_params" })
})

test.each([true, false])("oversized preview with declared length %s is refused before EOF", async declared => {
  const { deps } = await harness((_url, res) => {
    const size = MAX_FILE_PREVIEW_BYTES * 4 + 1
    if (declared) res.setHeader("content-length", size + 10)
    // Leave the response open. An unbounded reader cannot finish this request.
    res.write(Buffer.alloc(size, "x"))
  })
  expect(await Effect.runPromise(Effect.flip(deps.readFile(repo.owner, repo.name, "large", sha)))).toMatchObject({ code: "invalid_params" })
})

test.each([true, false])("preview preserves its UTF-8 boundary with declared length %s", async declared => {
  const prefix = "a".repeat(MAX_FILE_PREVIEW_BYTES - 1)
  const body = Buffer.from(prefix + "🌍")
  const { deps, database } = await harness((_url, res) => {
    if (declared) res.setHeader("content-length", body.length)
    res.write(body.subarray(0, MAX_FILE_PREVIEW_BYTES))
    res.end(body.subarray(MAX_FILE_PREVIEW_BYTES))
  })
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient))
  await runtime.runPromise(sql`INSERT INTO github_repositories (repo_id, private) VALUES (${repoScope}, false)
    ON CONFLICT (repo_id) DO UPDATE SET private = false`)
  const auth = await Effect.runPromise(makeMcpAuthService({ database }))
  const registry = await Effect.runPromise(makeMcpToolRegistry(deps).pipe(Effect.provideService(McpAuthService, auth)))
  const result = await Effect.runPromise(registry.callTool("repo_read_file", { path: "README", ref: sha }, {
    principal: Option.none(), defaultRepo: repo, origin, requestId: "boundary",
  }))
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ bytes: body.length, content: prefix, truncated: true })
})

test.each([100, 101])("issue_get reports whether the first comment page covers all %i comments", async count => {
  const comments = Array.from({ length: count }, (_, index) => ({ body: String(index) }))
  const { deps, database } = await harness((url, res) => {
    if (url.pathname.endsWith("/comments")) {
      const limit = Number(url.searchParams.get("per_page"))
      if (count > limit) res.setHeader("link", '<https://api.github.com/page2>; rel="next"')
      return void json(res, comments.slice(0, limit))
    }
    json(res, { number: 1 })
  })
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient))
  await runtime.runPromise(sql`INSERT INTO github_repositories (repo_id, private) VALUES (${repoScope}, false)
    ON CONFLICT (repo_id) DO UPDATE SET private = false`)
  const auth = await Effect.runPromise(makeMcpAuthService({ database }))
  const registry = await Effect.runPromise(makeMcpToolRegistry(deps).pipe(Effect.provideService(McpAuthService, auth)))
  const result = await Effect.runPromise(registry.callTool("issue_get", { number: 1 }, {
    principal: Option.none(), defaultRepo: repo, origin, requestId: "comments",
  }))
  const issue = JSON.parse(result.content.at(-1)!.text)
  expect(issue.comments).toHaveLength(100)
  expect(issue.comments[99].untrusted.body).toBe("99")
  expect(issue.commentsTruncated).toBe(count > 100)
})
