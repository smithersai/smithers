import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { APIError, Client, object, type Values } from "../src/internal/backend/Client.ts"
import { stacks } from "../src/internal/backend/Stack.ts"
const options = { repo: "owner/repo" }
const error = (status: number) => new APIError(status, {}, "GET", "/github", new Headers())
type GitHubEndpoint = (method: string, path: string, body?: Values) => unknown
class GitHubFault extends Context.Service<GitHubFault, GitHubEndpoint>()("test/stack/GitHubFault") {}
const cwd = process.cwd()
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  process.chdir(cwd)
  for (const close of cleanup.splice(0).reverse()) await close()
})
const fixture = async (
  config: {
    githubToken?: boolean
    merged?: string[]
    advanceTarget?: boolean
    changes?: Values[]
    locals?: string[]
    github?: GitHubEndpoint
  } = {}
) => {
  const home = await mkdtemp(join(tmpdir(), "smithers-stack-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SMITHERS_AUTH_FILE: join(home, "auth.json"),
    XDG_CONFIG_HOME: home,
    JJ_CONFIG: "",
    JJ_USER: "Author",
    JJ_EMAIL: "author@example.test",
    SMITHERS_TOKEN: "session",
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
  }
  const jj = (args: string[], directory = join(home, "local")) =>
    execFileSync("jj", args[0] === "log" ? ["--ignore-working-copy", ...args] : args, {
      cwd: directory,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim()
  const upstream = join(home, "upstream")
  jj(["git", "init", "--no-colocate", upstream], home)
  await writeFile(join(upstream, "base.txt"), "base\n")
  jj(["describe", "-m", "Base"], upstream)
  jj(["bookmark", "create", "main"], upstream)
  jj(["git", "export"], upstream)
  jj(
    ["git", "clone", "--no-colocate", "--remote", "origin", join(upstream, ".jj/repo/store/git"), join(home, "local")],
    home
  )
  jj(["bookmark", "track", "main@origin"])
  jj(["new", "main@origin"])
  jj(["config", "set", "--repo", "git.push-new-bookmarks", "true"])
  const initial = config.changes ?? [{
    change_id: "a1234567",
    position: 0,
    pr_number: 1,
    body: "Notes\n<!-- smithers:stack:start -->old<!-- smithers:stack:end -->"
  }]
  const aliases = new Map<string, string>()
  const localNames = config.locals ?? [...initial]
    .sort((a, b) => Number(b.position ?? initial.indexOf(b)) - Number(a.position ?? initial.indexOf(a)))
    .map((change) => String(change.change_id))
  for (const name of [...localNames].reverse()) {
    await writeFile(join(home, "local", name + ".txt"), name + "\n")
    jj(["describe", "-m", "Change title\n\nNotes\n<!-- smithers:stack:start -->old<!-- smithers:stack:end -->"])
    aliases.set(name, jj(["log", "-r", "@", "--no-graph", "-T", "change_id"]))
    jj(["new", "@"])
  }
  const id = (name: string) => aliases.get(name) ?? name
  const branch = (name: string) => "smithers/" + id(name).slice(0, 8)
  const translate = (value: unknown): unknown => {
    if (typeof value === "string") {
      let text = id(value)
      for (const [name, actual] of aliases) {
        text = text.replaceAll("smithers/" + name, "smithers/" + actual.slice(0, 8))
          .replaceAll("smithers:write=" + name, "smithers:write=" + actual)
      }
      return text
    }
    if (Array.isArray(value)) return value.map(translate)
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, translate(entry)])
      )
    }
    return value
  }
  for (const change of initial) {
    if (!aliases.has(String(change.change_id)) || !change.pr_number) continue
    jj(["bookmark", "set", "-B", branch(String(change.change_id)), "-r", id(String(change.change_id))])
    jj(["git", "push", "--bookmark", branch(String(change.change_id))])
  }
  let active: Values | undefined = { id: "stack", changes: translate(initial) }
  const pulls = new Map<number, Values>(
    initial.filter((change) => change.pr_number).map((change) => [
      Number(change.pr_number),
      {
        number: change.pr_number,
        state: config.merged?.includes(String(change.change_id)) ? "closed" : "open",
        merged: config.merged?.includes(String(change.change_id)) ?? false,
        head: {
          ref: aliases.has(String(change.change_id)) ? branch(String(change.change_id)) : undefined,
          sha: aliases.has(String(change.change_id)) ?
            jj(["log", "-r", id(String(change.change_id)), "--no-graph", "-T", "commit_id"]) :
            "missing"
        },
        mergeable: true,
        html_url: "https://github.test/pr",
        body: change.body
      }
    ])
  )
  if (config.merged?.length) {
    jj(["git", "import"], upstream)
    jj(["bookmark", "set", "main", "-r", id(config.merged.at(-1)!)], upstream)
    if (config.advanceTarget) {
      jj(["new", "main"], upstream)
      await writeFile(join(upstream, "upstream.txt"), "Upstream change\n")
      jj(["describe", "-m", "Upstream change"], upstream)
      jj(["bookmark", "set", "main", "-r", "@"], upstream)
    }
    jj(["git", "export"], upstream)
  }
  const githubCalls: Array<[string, string, Values | undefined]> = []
  const requests: Array<
    [string, string, Values | undefined, { origin: string; headers: Record<string, string | undefined> }]
  > = []
  let created = 10
  const github = async (method: string, path: string, body?: Values) => {
    githubCalls.push([method, path, body])
    const custom = await Effect.runPromise(
      Effect.gen(function*() {
        const fault = yield* GitHubFault
        return yield* Effect.try({
          try: () => fault(method, path, body),
          catch: (cause) => cause instanceof APIError ? cause : error(500)
        })
      }).pipe(Effect.provideService(GitHubFault, config.github ?? (() => undefined)))
    )
    if (custom !== undefined) {
      const translated = translate(custom)
      if (method === "GET" && path.includes("/pulls?") && Array.isArray(translated)) {
        for (const pull of translated) pulls.set(Number(object(pull).number), object(pull))
      }
      const number = Number(path.split("/").at(-1))
      if (method === "PATCH" && number > 0) pulls.set(number, { ...object(translated), ...body, number })
      return translated
    }
    const url = new URL(path, "http://github.test")
    if (url.pathname.endsWith("/check-runs")) {
      return { check_runs: [{ name: "CI", status: "completed", conclusion: "success" }] }
    }
    if (url.pathname.endsWith("/reviews")) return [{ user: { login: "owner" }, state: "APPROVED" }]
    if (url.pathname.endsWith("/pulls") && method === "GET") return []
    if (url.pathname.endsWith("/pulls") && method === "POST") {
      const pull = {
        ...body,
        number: created++,
        state: "open",
        merged: false,
        mergeable: true,
        head: { ref: body!.head, sha: jj(["log", "-r", String(body!.head), "--no-graph", "-T", "commit_id"]) },
        html_url: "https://github.test/pr"
      }
      pulls.set(pull.number, pull)
      return pull
    }
    if (path.endsWith("/merge") && method === "PUT") {
      const number = Number(path.split("/").at(-2)), pull = pulls.get(number)!
      if (object(pull.head).sha !== body?.sha) throw error(409)
      jj(["git", "import"], upstream)
      jj(["bookmark", "set", "main", "-r", String(body!.sha)], upstream)
      jj(["git", "export"], upstream)
      pulls.set(number, { ...pull, state: "closed", merged: true })
      return { merged: true }
    }
    if (method === "DELETE" && path.includes("/git/refs/heads/")) {
      jj(["git", "import"], upstream)
      jj(["bookmark", "delete", decodeURIComponent(path.split("/heads/")[1]!)], upstream)
      jj(["git", "export"], upstream)
      return {}
    }
    const number = Number(path.split("/").at(-1)), pull = pulls.get(number)
    if (!pull) throw error(404)
    const head = object(pull.head)
    if (head.ref) {
      jj(["git", "import"], upstream)
      head.sha = jj(["log", "-r", String(head.ref), "--no-graph", "-T", "commit_id"], upstream)
    }
    if (method === "PATCH") pulls.set(number, { ...pull, ...body })
    return pulls.get(number)
  }
  const server = createServer((request, response) => {
    void (async () => {
      let text = ""
      for await (const chunk of request) text += chunk
      const body = text ? JSON.parse(text) as Values : undefined
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing HTTP address")
      requests.push([request.method!, request.url!, body, {
        origin: "http://127.0.0.1:" + address.port,
        headers: { authorization: request.headers.authorization }
      }])
      let result: unknown
      if (request.url!.startsWith("/api/repos/owner/repo/stacks/active")) {
        if (request.method === "DELETE") {
          active = undefined
          result = {}
        } else if (request.method === "POST") {
          active = { id: "stack", ...body }
          result = active
        } else {
          if (!active) throw error(404)
          result = active
        }
      } else if (request.url === "/api/repos/owner/repo/github-proxy") {
        if (request.headers.authorization !== "token session") throw error(401)
        result = await github(String(body!.method), String(body!.path), body!.body as Values | undefined)
      } else if (request.url!.startsWith("/repos/owner/repo/")) {
        if (request.headers.authorization !== "Bearer github-secret") throw error(401)
        result = await github(request.method!, request.url!, body)
      } else throw error(404)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(result))
    })().catch((cause: unknown) => {
      response.writeHead(cause instanceof APIError ? cause.status : 500, { "content-type": "application/json" })
      response.end(JSON.stringify({ message: cause instanceof Error ? cause.message : "Request failed" }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing HTTP address")
  const origin = "http://127.0.0.1:" + address.port
  process.chdir(join(home, "local"))
  const c = new Client({
    environment: {
      ...environment,
      SMITHERS_API_ORIGIN: origin,
      ...(config.githubToken ? { GITHUB_TOKEN: "github-secret", SMITHERS_GITHUB_API_URL: origin } : {})
    }
  })
  return { c, id, branch, jj, upstream, origin, githubCalls, requests, pulls, active: () => active }
}
describe("stack synchronization and merge safety", () => {
  it("updates existing PRs in one ordered stack using direct GitHub auth", async () => {
    const f = await fixture({
      githubToken: true,
      changes: [{ change_id: "second", pr_number: 2, position: 1 }, { change_id: "first", pr_number: 1, position: 0 }],
      locals: ["second", "first"]
    })
    const result = object(await stacks["stack submit"]!(f.c, {}, { ...options, draft: true }))
    expect(result.auth_source).toBe("github_token")
    expect(result.change_ids).toEqual([f.id("first"), f.id("second")])
    expect(object(f.active()).changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ change_id: f.id("first"), position: 0, pr_number: 1 }),
      expect.objectContaining({ change_id: f.id("second"), position: 1, pr_number: 2 })
    ]))
    for (const name of ["first", "second"]) {
      expect(f.jj(["log", "-r", f.branch(name) + "@origin", "--no-graph", "-T", "change_id"])).toBe(f.id(name))
    }
    const patch = f.githubCalls.find(([method, path, body]) => method === "PATCH" && path.endsWith("/2") && body?.base)
    expect(patch?.[2]?.base).toBe(f.branch("first"))
    const bodies = f.githubCalls.filter(([method, , body]) => method === "PATCH" && body?.body).map((
      [, , body]
    ) => String(body!.body))
    expect(bodies.at(-1)).toContain("#1")
    expect(bodies.at(-1)).toContain("#2")
    expect(bodies.at(-1)).not.toContain("-->old<!--")
    expect(f.requests.find(([, path]) => path.startsWith("/repos/"))?.[3]).toMatchObject({
      origin: f.origin,
      headers: { authorization: "Bearer github-secret" }
    })
  })
  it("creates and pushes a new ordered stack, then removes its backend and branch state on unsubmit", async () => {
    const f = await fixture({ changes: [], locals: ["second", "first"] })
    const submitted = object(await stacks["stack submit"]!(f.c, {}, options))
    expect(submitted.pr_numbers).toEqual([10, 11])
    expect(submitted.change_ids).toEqual([f.id("first"), f.id("second")])
    for (const name of ["first", "second"]) {
      expect(f.jj(["log", "-r", f.branch(name) + "@origin", "--no-graph", "-T", "change_id"])).toBe(f.id(name))
    }
    expect(f.pulls.get(10)?.base).toBe("main")
    expect(f.pulls.get(11)?.base).toBe(f.branch("first"))
    expect(object(f.active()).changes).toHaveLength(2)
    expect(await stacks["stack unsubmit"]!(f.c, {}, options)).toMatchObject({ stack_deleted: true })
    expect(f.active()).toBeUndefined()
    expect([...f.pulls.values()].map((pull) => pull.state)).toEqual(["closed", "closed"])
    expect(f.jj(["bookmark", "list", "--no-pager"], f.upstream)).not.toContain("smithers/")
    await expect(f.c.request("GET", "/api/repos/owner/repo/stacks/active")).rejects.toMatchObject({ status: 404 })
  })

  it.each([404, 503])("handles updating a PR after HTTP %s", async (status) => {
    let failed = false
    const f = await fixture({
      github: (method) => {
        if (method === "PATCH" && !failed) {
          failed = true
          throw error(status)
        }
      }
    })
    if (status === 404) expect(object(await stacks["stack submit"]!(f.c, {}, options)).pr_numbers).toEqual([10])
    else await expect(stacks["stack submit"]!(f.c, {}, options)).rejects.toThrow("503")
  })
  it("rejects incomplete PR receipts and empty local stacks", async () => {
    const f = await fixture({ github: () => ({}) })
    await expect(stacks["stack submit"]!(f.c, {}, options)).rejects.toThrow("PR number")
    const empty = await fixture({ locals: [] })
    await expect(stacks["stack submit"]!(empty.c, {}, options)).rejects.toThrow("No non-empty")
  })
  it("restacks every unmerged change after fetching authoritative PR state", async () => {
    const f = await fixture({
      changes: [{ change_id: "merged", pr_number: 1 }, { change_id: "first", pr_number: 2 }, {
        change_id: "second",
        pr_number: 3
      }],
      merged: ["merged"],
      advanceTarget: true
    })
    const result = object(await stacks["stack sync"]!(f.c, {}, options))
    expect(result.merged).toEqual([expect.objectContaining({ change_id: f.id("merged") })])
    expect(result.remaining).toHaveLength(2)
    const target = f.jj(["log", "-r", "main", "--no-graph", "-T", "change_id"], f.upstream)
    expect(f.jj(["log", "-r", "main", "--no-graph", "-T", "change_id"])).toBe(target)
    expect(f.jj(["log", "-r", f.id("first") + "-", "--no-graph", "-T", "change_id"])).toBe(target)
    expect(f.jj(["log", "-r", f.id("second") + "-", "--no-graph", "-T", "change_id"])).toBe(f.id("first"))
    expect(f.jj(["log", "-r", f.id("first"), "--no-graph", "-T", "author.name()"])).toBe("Author")
    expect(object(f.active()).changes).toHaveLength(2)
  })
  it("removes a stack after all PRs have merged", async () => {
    const f = await fixture({ merged: ["a1234567"] })
    expect(await stacks["stack sync"]!(f.c, {}, options)).toMatchObject({ stack_deleted: true, remaining: [] })
  })
  it("refuses restacking when a local change or PR mapping is missing", async () => {
    const missing = await fixture({ locals: [] })
    await expect(stacks["stack sync"]!(missing.c, {}, options)).rejects.toThrow("Local stack is missing")
    const unmapped = await fixture({ changes: [{ change_id: "abc" }] })
    await expect(stacks["stack sync"]!(unmapped.c, {}, options)).rejects.toThrow("pr_number")
    await expect(stacks["stack land"]!(unmapped.c, {}, options)).rejects.toThrow("pr_number")
  })
  it("shows local changes missing from the backend mapping without treating them as mergeable", async () => {
    const f = await fixture({ locals: ["unsubmitted", "a1234567"] })
    const result = object(await stacks["stack status"]!(f.c, {}, options))
    expect(result.changes).toEqual([
      expect.objectContaining({ change_id: f.id("unsubmitted"), pr_number: null, mergeable: false }),
      expect.objectContaining({ change_id: f.id("a1234567") })
    ])
  })
  it.each(["neutral", "skipped", "unknown", "failure"])(
    "normalizes a completed check with conclusion %s",
    async (conclusion) => {
      const f = await fixture({
        github: (_method, path) =>
          path.split("?")[0]!.endsWith("/check-runs")
            ? { check_runs: [{ status: "completed", conclusion }] }
            : undefined
      })
      const result = object(await stacks["stack status"]!(f.c, {}, options))
      expect(object((result.changes as unknown[])[0]).ci_status).toBe(
        ["neutral", "skipped"].includes(conclusion) ? "passing" : conclusion === "failure" ? "failing" : "pending"
      )
    }
  )
  it("uses the latest decisive review for each reviewer", async () => {
    const f = await fixture({
      github: (_method, path) =>
        path.split("?")[0]!.endsWith("/reviews")
          ? [
            { user: { login: "Zoe" }, state: "APPROVED" },
            { user: { login: "alice" }, state: "APPROVED" },
            { user: { login: "ALICE" }, state: "CHANGES_REQUESTED" },
            { user: { login: "alice" }, state: "COMMENTED" },
            { state: "APPROVED" }
          ]
          : undefined
    })
    const result = object(await stacks["stack status"]!(f.c, {}, options))
    expect(object((result.changes as unknown[])[0])).toMatchObject({
      review_status: "changes_requested",
      reviewers: [{ login: "ALICE", state: "changes_requested" }, { login: "Zoe", state: "approved" }]
    })
  })
  it.each(["review", "checks", "closed", "sha", "empty-checks"])(
    "refuses merging with non-passing %s evidence",
    async (kind) => {
      const f = await fixture({
        github: (_method, path) => {
          if (path.split("?")[0]!.endsWith("/reviews") && kind === "review") return []
          if (path.split("?")[0]!.endsWith("/check-runs") && kind === "checks") {
            return { check_runs: [{ status: "completed", conclusion: "failure" }] }
          }
          if (path.split("?")[0]!.endsWith("/check-runs") && kind === "empty-checks") return { check_runs: [] }
          if (path.endsWith("/1") && kind === "closed") {
            return { state: "closed", merged: true, head: { sha: "commit" } }
          }
          if (path.endsWith("/1") && kind === "sha") {
            return { state: "open", head: {} }
          }
        }
      })
      await expect(stacks["stack land"]!(f.c, {}, { ...options, all: kind === "review" })).rejects.toThrow()
      expect(f.githubCalls.some(([method]) => method === "PUT")).toBe(false)
    }
  )
  it.each([{ change: "" }, { change: "a", all: true }, { change: "missing" }])(
    "refuses invalid change selection %j",
    async (selection) => {
      const f = await fixture()
      await expect(stacks["stack land"]!(f.c, {}, { ...options, ...selection })).rejects.toThrow()
    }
  )
  it("refuses ambiguous change prefixes and an empty active stack", async () => {
    const f = await fixture({
      changes: [{ change_id: "abc", pr_number: 1 }, { change_id: "abc", pr_number: 2 }],
      locals: ["abc"]
    })
    await expect(stacks["stack land"]!(f.c, {}, { ...options, change: f.id("abc") })).rejects.toThrow("ambiguous")
    const empty = await fixture({ changes: [] })
    await expect(stacks["stack land"]!(empty.c, {}, options)).rejects.toThrow("no changes")
  })
  it.each(["all", "prefix"])("lands the selected ordered prefix (%s)", async (kind) => {
    const f = await fixture({ changes: [{ change_id: "abc1", pr_number: 1 }, { change_id: "def2", pr_number: 2 }] })
    const result = object(
      await stacks["stack land"]!(f.c, {}, {
        ...options,
        ...(kind === "all" ? { all: true } : { change: f.id("def2").slice(0, 8) })
      })
    )
    expect(result.landed).toHaveLength(2)
    expect(result.stack_deleted).toBe(true)
    expect(f.active()).toBeUndefined()
    expect(f.jj(["log", "-r", "main", "--no-graph", "-T", "change_id"], f.upstream)).toBe(f.id("def2"))
    expect([...f.pulls.values()].every((pull) => pull.merged === true && pull.state === "closed")).toBe(true)
    await expect(f.c.request("GET", "/api/repos/owner/repo/stacks/active")).rejects.toMatchObject({ status: 404 })
  })
  it.each(["fallback", "all-rejected", "failed", "not-merged"])(
    "handles merge result %s without claiming success",
    async (kind) => {
      const f = await fixture({
        github: (_method, path, body) => {
          if (!path.endsWith("/merge")) return
          if (kind === "not-merged") return { merged: false }
          if (kind === "failed") throw error(503)
          if (kind === "all-rejected" || body?.merge_method === "merge") throw error(405)
        }
      })
      if (kind === "fallback") {
        expect(object(await stacks["stack land"]!(f.c, {}, options)).landed).toHaveLength(1)
        expect(f.githubCalls.some(([, , body]) => body?.merge_method === "squash")).toBe(true)
      } else await expect(stacks["stack land"]!(f.c, {}, options)).rejects.toThrow()
    }
  )
  it("rechecks gates immediately before merging", async () => {
    let checks = 0
    const f = await fixture({
      github: (_method, path) =>
        path.split("?")[0]!.endsWith("/check-runs") && ++checks > 1 ? { check_runs: [] } : undefined
    })
    await expect(stacks["stack land"]!(f.c, {}, options)).rejects.toThrow("Refusing")
    expect(f.githubCalls.some(([method]) => method === "PUT")).toBe(false)
  })
  it.each([404, 422, 503])("handles unsubmit cleanup with HTTP %s", async (status) => {
    const f = await fixture({
      github: (method) => {
        if (method === "DELETE") throw error(status)
        return { state: "closed" }
      }
    })
    if (status === 503) await expect(stacks["stack unsubmit"]!(f.c, {}, options)).rejects.toThrow("503")
    else {expect(await stacks["stack unsubmit"]!(f.c, {}, options)).toMatchObject({
        prs: [{ pr_number: 1, status: "already_closed" }],
        branches: [{ branch: f.branch("a1234567"), status: "missing" }]
      })}
  })
  it.each([404, 503])("handles a missing PR during unsubmit (%s)", async (status) => {
    const f = await fixture({
      github: (method) => {
        if (method === "GET") throw error(status)
      }
    })
    if (status === 404) {
      expect(object(await stacks["stack unsubmit"]!(f.c, {}, options)).prs).toEqual([{
        pr_number: 1,
        status: "missing"
      }])
    } else await expect(stacks["stack unsubmit"]!(f.c, {}, options)).rejects.toThrow("503")
  })
  it("accepts a concurrent close only after rereading the PR", async () => {
    let reads = 0
    const f = await fixture({
      github: (method) => {
        if (method === "PATCH") throw error(422)
        if (method === "GET") return { state: ++reads === 1 ? "open" : "closed" }
      }
    })
    expect(object(await stacks["stack unsubmit"]!(f.c, {}, options)).stack_deleted).toBe(true)
    expect(reads).toBe(2)
  })
})

// `stack submit` finds the pull request a change opened by the change's own head bookmark and the hidden marker naming
// its change id. Before, a run that died after GitHub opened it, before the stack state recorded it, posted again,
// got GitHub's 422, and failed.
describe("stack submit after a lost answer", () => {
  const OWN = "a1234567"
  const marked = (text: string) => `${text}\n\n<!-- smithers:write=${OWN} -->`
  const listing = (path: string) => path.includes("/pulls?")
  const pullsOf = (...pulls: Array<Values>) =>
    pulls.map((pull) => ({ state: "open", html_url: "https://github.test/pr", ...pull }))

  it("adopts the change's own pull request from its head, and never a pull request from that head without its marker", async () => {
    const f = await fixture({
      changes: [],
      locals: [OWN],
      github: (method, path) =>
        method === "GET" && listing(path)
          ? pullsOf({ number: 5, body: "Someone else's" }, { number: 7, body: marked("Notes") }, {
            number: 8,
            body: marked("a copy")
          })
          : undefined
    })
    const result = object(await stacks["stack submit"]!(f.c, {}, options))
    expect(result.pr_numbers).toEqual([7])
    expect(f.githubCalls.filter(([method, path]) => method === "POST" && path.endsWith("/pulls"))).toHaveLength(0)
    const lookup = f.githubCalls.find(([method, path]) => method === "GET" && listing(path))![1]
    const search = new URL(lookup, "https://github.test").searchParams
    expect(Object.fromEntries(search)).toEqual({ head: "owner:" + f.branch(OWN), state: "all", per_page: "100" })
    // Every body it writes carries the change's marker once, so a later run finds it the same way.
    const bodies = f.githubCalls.filter(([method, , body]) => method === "PATCH" && body?.body).map((
      [, , body]
    ) => String(body!.body))
    for (const text of bodies) expect(text.split("<!-- smithers:write=" + f.id(OWN) + " -->")).toHaveLength(2)
    expect(bodies.at(-1)).toMatch("<!-- smithers:write=" + f.id(OWN) + " -->")
  })

  it("adopts its own pull request after GitHub refuses a second one from its head", async () => {
    let lists = 0
    const f = await fixture({
      changes: [],
      locals: [OWN],
      github: (method, path) => {
        if (method === "GET" && listing(path)) {
          lists++
          return lists === 1 ?
            pullsOf({ number: 5, body: "Someone else's" }) :
            pullsOf({ number: 5, body: "Someone else's" }, {
              number: 9,
              body: marked("Notes")
            })
        }
        if (method === "POST" && path.endsWith("/pulls")) throw error(422)
      }
    })
    expect(object(await stacks["stack submit"]!(f.c, {}, options)).pr_numbers).toEqual([9])
    expect(lists).toBe(2)
  })

  it("fails on GitHub's refusal when only someone else's pull request comes from its head", async () => {
    const f = await fixture({
      changes: [],
      locals: [OWN],
      github: (method, path) => {
        if (method === "GET" && listing(path)) return pullsOf({ number: 5, body: "Someone else's" })
        if (method === "POST" && path.endsWith("/pulls")) throw error(422)
      }
    })
    await expect(stacks["stack submit"]!(f.c, {}, options)).rejects.toThrow("422")
    const other = await fixture({
      changes: [],
      locals: [OWN],
      github: (method, path) => {
        if (method === "POST" && path.endsWith("/pulls")) throw error(503)
      }
    })
    await expect(stacks["stack submit"]!(other.c, {}, options)).rejects.toThrow("503")
    expect(other.githubCalls.filter(([method, path]) => method === "GET" && listing(path))).toHaveLength(1)
  })

  it("refuses rather than open a second pull request when its head has too many to read", async () => {
    const f = await fixture({
      changes: [],
      locals: [OWN],
      github: (method, path) =>
        method === "GET" && listing(path)
          ? pullsOf(...Array.from({ length: 100 }, (_, i) => ({ number: 100 + i, body: "Someone else's" })))
          : undefined
    })
    await expect(stacks["stack submit"]!(f.c, {}, options)).rejects.toThrow("could not be ruled out")
    expect(f.githubCalls.filter(([method, path]) => method === "POST" && path.endsWith("/pulls"))).toHaveLength(0)
  })
})
