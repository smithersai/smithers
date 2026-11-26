import { ImmutableCache } from "@smthrs/artifacts"
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, test, vi } from "vitest"
import { MAX_LISTED } from "../../src/features/docs/contract.ts"
import { StartUnavailable } from "../Flows.ts"
import * as Store from "../github/Store.vibe"
import * as RepoReads from "../RepoReads.ts"
import { makeLiveDeps } from "./LiveDeps.vibe"

const emptySql = Layer.succeed(
  SqlClient.SqlClient,
  Object.assign(
    (() => Effect.succeed([])) as unknown as SqlClient.SqlClient,
    { withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff },
  ),
)

const emptyCache = Layer.succeed(
  ImmutableCache.ImmutableCache,
  {
    get: () => Effect.succeed(Option.none()),
    put: () => Effect.void,
  } as unknown as ImmutableCache.ImmutableCache["Service"],
)

const stubStarter = {
  start: () => Effect.die(new Error("unexpected starter call")),
}

describe("LiveDeps public GitHub fallback", () => {
  test("reads refs, tree, files, issues, and pulls via unauthenticated GitHub API when repo is not yet cloned/synced", async () => {
    const seenHeaders: Array<Record<string, string>> = []
    const client = HttpClient.make((request) => {
      seenHeaders.push({ ...request.headers })
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })))
      if (url.pathname === "/repos/evmts/voltaire") return json({ default_branch: "main" })
      if (url.pathname === "/repos/evmts/voltaire/git/ref/heads/main") {
        return json({ object: { sha: "f79b1033ac63536d3ed0129fc18cb0a9bcd021fb" } })
      }
      if (url.pathname === "/repos/evmts/voltaire/branches") return json([{ name: "main" }, { name: "next" }])
      if (url.pathname === "/repos/evmts/voltaire/tags") return json([{ name: "v0.2.27" }])
      if (url.pathname === "/repos/evmts/voltaire/git/trees/main") {
        return json({
          sha: "f79b1033ac63536d3ed0129fc18cb0a9bcd021fb",
          truncated: false,
          tree: [
            { path: ".smithers", type: "tree" },
            { path: ".smithers/factory.json", type: "blob" },
            { path: "README.md", type: "blob" },
          ],
        })
      }
      if (url.pathname === "/repos/evmts/voltaire/contents/.smithers/factory.json") {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ flows: [{ id: "issue/repro" }] }), { status: 200 }),
          ),
        )
      }
      if (url.pathname === "/repos/evmts/voltaire/issues") {
        return json([
          { number: 401, title: "Keccak bug", state: "open", user: { login: "alice" }, comments: 2, updated_at: "2026-11-22T00:00:00Z" },
          { number: 400, title: "PR filtered out", state: "open", user: { login: "roninjin10" }, comments: 0, updated_at: "2026-11-22T00:00:00Z", pull_request: {} },
        ])
      }
      if (url.pathname === "/repos/evmts/voltaire/pulls") {
        return json([
          {
            number: 402,
            title: "Fix P256",
            state: "open",
            user: { login: "roninjin10" },
            head: { ref: "fix-p256" },
            base: { ref: "main" },
            draft: false,
            updated_at: "2026-11-22T00:00:00Z",
          },
        ])
      }
      return json({ message: "Not Found" }, 404)
    })

    const deps = await Effect.runPromise(
      makeLiveDeps({
        database: emptySql,
        reads: Option.none(),
        repoCache: emptyCache,
        starter: stubStarter as never,
        githubFallbackClient: client,
      }),
    )

    const refs = await Effect.runPromise(deps.listRefs("evmts", "voltaire"))
    expect(refs).toEqual({
      defaultBranch: "main",
      head: "f79b1033ac63536d3ed0129fc18cb0a9bcd021fb",
      branches: ["main", "next"],
      tags: ["v0.2.27"],
    })

    const tree = await Effect.runPromise(deps.readTree("evmts", "voltaire"))
    expect(tree.paths).toEqual([".smithers/factory.json", "README.md"])

    const file = await Effect.runPromise(deps.readFile("evmts", "voltaire", ".smithers/factory.json"))
    expect(JSON.parse(file.content)).toEqual({ flows: [{ id: "issue/repro" }] })

    const missing = await Effect.runPromise(deps.readFile("evmts", "voltaire", "does-not-exist.ts").pipe(Effect.result))
    expect(missing._tag).toBe("Failure")
    if (missing._tag === "Failure") expect(missing.failure.code).toBe("not_found")

    const issues = await Effect.runPromise(deps.listIssues("evmts", "voltaire", { state: "open", q: "", limit: 10 }))
    expect(issues.issues).toHaveLength(1)
    expect(issues.issues[0]!.number).toBe(401)

    const pulls = await Effect.runPromise(deps.listPulls("evmts", "voltaire", "open"))
    expect(pulls).toHaveLength(1)
    expect(pulls[0]!.number).toBe(402)

    // Security invariant: unauthenticated public fallback NEVER sends Authorization headers
    expect(seenHeaders.length).toBeGreaterThan(0)
    for (const h of seenHeaders) {
      expect(h["authorization"]).toBeUndefined()
      expect(h["user-agent"]).toBe("smithers-mcp")
    }
  })
})

describe("LiveDeps public GitHub fallback with the deployment read token", () => {
  test("sends the read token so Workers avoid the shared anonymous quota, and retries anonymously on a non-quota 403", async () => {
    const authHeaders: Array<string | undefined> = []
    const client = HttpClient.make((request) => {
      const auth = request.headers["authorization"]
      authHeaders.push(auth)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers })))
      if (url.pathname === "/repos/evmts/voltaire") return json({ default_branch: "main" })
      if (url.pathname === "/repos/evmts/voltaire/git/ref/heads/main") {
        return auth === undefined
          ? json({ object: { sha: "a".repeat(40) } })
          : json({ message: "Resource not accessible by integration" }, 403, { "x-ratelimit-remaining": "4999" })
      }
      if (url.pathname === "/repos/evmts/voltaire/branches") return json([{ name: "main" }])
      if (url.pathname === "/repos/evmts/voltaire/tags") return json([])
      return json({ message: "Not Found" }, 404)
    })

    const deps = await Effect.runPromise(
      makeLiveDeps({
        database: emptySql,
        reads: Option.none(),
        repoCache: emptyCache,
        starter: stubStarter as never,
        githubFallbackClient: client,
        githubReadToken: Effect.succeed(Option.some(Redacted.make("ghs_test_read_token"))),
      }),
    )

    const refs = await Effect.runPromise(deps.listRefs("evmts", "voltaire"))
    expect(refs).toEqual({ defaultBranch: "main", head: "a".repeat(40), branches: ["main"], tags: [] })
    expect(authHeaders[0]).toBe("Bearer ghs_test_read_token")
    expect(authHeaders.filter((h) => h === undefined)).toHaveLength(1)
  })

  test("a quota-exhausted 403 with the read token surfaces rate_limited without an anonymous retry", async () => {
    let calls = 0
    const client = HttpClient.make((request) => {
      calls++
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
            status: 403,
            headers: { "x-ratelimit-remaining": "0" },
          }),
        ),
      )
    })
    const deps = await Effect.runPromise(
      makeLiveDeps({
        database: emptySql,
        reads: Option.none(),
        repoCache: emptyCache,
        starter: stubStarter as never,
        githubFallbackClient: client,
        githubReadToken: Effect.succeed(Option.some(Redacted.make("ghs_test_read_token"))),
      }),
    )
    const result = await Effect.runPromise(deps.listRefs("evmts", "voltaire").pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("rate_limited")
    expect(calls).toBe(1)
  })
})


describe("LiveDeps pull_files and docsSource", () => {
  test("reads PR changed files via GitHub API and docs via DocsSource", async () => {
    const client = HttpClient.make((request) => {
      const url = new URL(request.url)
      if (url.pathname === "/repos/evmts/voltaire/pulls/397/files") {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify([
                { filename: "package.json", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-a\n+b" },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        )
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 })))
    })

    const fakeDocsSource = {
      index: () =>
        Effect.succeed({
          _tag: "Index" as const,
          source: "declared" as const,
          cached: true,
          index: {
            title: "Voltaire",
            url: "https://voltaire.tevm.sh/llms.txt",
            pages: [
              { title: "Address Overview", path: "/primitives/address", url: "https://voltaire.tevm.sh/primitives/address", section: "Core Primitives" },
            ],
          },
        }),
      page: (_o: string, _n: string, path: string) =>
        path === "/primitives/address"
          ? Effect.succeed({
              _tag: "Page" as const,
              cached: true,
              page: { title: "Address Overview", path, url: "https://voltaire.tevm.sh/primitives/address" },
              text: "# Address",
            })
          : Effect.succeed({ _tag: "Refused" as const, code: "page_not_found" as const }),
    }

    const deps = await Effect.runPromise(
      makeLiveDeps({
        database: emptySql,
        reads: Option.none(),
        repoCache: emptyCache,
        starter: stubStarter as never,
        githubFallbackClient: client,
        docsSource: fakeDocsSource,
      }),
    )

    const files = await Effect.runPromise(deps.getPullFiles("evmts", "voltaire", 397))
    expect(files.files).toHaveLength(1)
    expect(files.files[0]!.filename).toBe("package.json")
    expect(files.files[0]!.patch).toContain("+b")

    const docs = await Effect.runPromise(deps.listDocs("evmts", "voltaire", "address"))
    expect(docs.pages).toHaveLength(1)
    expect(docs.pages[0]!.path).toBe("/primitives/address")

    const page = await Effect.runPromise(deps.readDoc("evmts", "voltaire", "/primitives/address"))
    expect(page.content).toBe("# Address")
  })
})

test.each([404, 410, 403, 429, 500])("maps an upstream HTTP %i to a tool error", async (status) => {
  const client = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status }))))
  const deps = await Effect.runPromise(makeLiveDeps({
    database: emptySql,
    reads: Option.none(),
    repoCache: emptyCache,
    starter: stubStarter,
    githubFallbackClient: client,
  }))
  const error = await Effect.runPromise(Effect.flip(deps.readTree("acme", "project", "main")))
  expect(error.code).toBe(status === 404 || status === 410 ? "not_found"
    : status === 403 || status === 429 ? "rate_limited" : "unavailable")
})

test("distinguishes missing services, invalid cursors, and absent database rows", async () => {
  const deps = await Effect.runPromise(makeLiveDeps({
    database: emptySql,
    reads: Option.none(),
    repoCache: emptyCache,
    starter: stubStarter,
  }))
  const failure = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(program))
  await expect(failure(deps.listRefs("acme", "project"))).resolves.toMatchObject({ code: "unavailable" })
  await expect(failure(deps.getIssue("acme", "project", 1))).resolves.toMatchObject({ code: "not_found" })
  await expect(failure(deps.getPull("acme", "project", 1))).resolves.toMatchObject({ code: "not_found" })
  await expect(failure(deps.listIssues("acme", "project", {
    state: "open", q: "", limit: 10, cursor: "malformed",
  }))).resolves.toMatchObject({ code: "invalid_params" })
  await expect(failure(deps.listDocs("acme", "project", ""))).resolves.toMatchObject({ code: "unavailable" })
  await expect(failure(deps.readDoc("acme", "project", "/missing"))).resolves.toMatchObject({ code: "unavailable" })
  await expect(Effect.runPromise(deps.listPulls("acme", "project", "all"))).resolves.toEqual([])
})

test("mirror reads resolve branch, tag, and commit refs before decoding tree and file bytes", async () => {
  const head = "a".repeat(40)
  const branch = "b".repeat(40)
  const tag = "c".repeat(40)
  const listing = {
    defaultBranch: "main", head, refsChangedAt: null, branches: [{ name: "dev", sha: branch }],
    tags: [{ name: "v1", sha: tag }], truncated: false,
  }
  const unexpected = () => Effect.die("unexpected mirror read")
  const reads: ReturnType<typeof RepoReads.make<unknown, never>> = {
    files: unexpected,
    download: unexpected,
    refs: () => Effect.succeed(listing),
    tree: (_owner: string, _name: string, sha: string) => Effect.succeed(new TextEncoder().encode(
      sha === branch ? "invalid" : JSON.stringify({ paths: ["README"], truncated: false }),
    )),
    blob: (_owner: string, _name: string, _sha: string, path: string) =>
      Effect.succeed({ bytes: path === "binary" ? Uint8Array.of(0) : new TextEncoder().encode("hello"), metadata: {} }),
  }
  const deps = await Effect.runPromise(makeLiveDeps({
    database: emptySql,
    reads: Option.some(reads),
    repoCache: emptyCache,
    starter: stubStarter,
  }))
  const owner = "acme"
  const name = "project"
  await expect(Effect.runPromise(deps.listRefs(owner, name))).resolves.toEqual({
    defaultBranch: "main", head, branches: ["dev"], tags: ["v1"],
  })
  for (const [ref, sha] of [[undefined, head], ["main", head], ["v1", tag], [tag.toUpperCase(), tag]] as const) {
    await expect(Effect.runPromise(deps.readTree(owner, name, ref))).resolves.toEqual({
      ref: sha, paths: ["README"], truncated: false,
    })
  }
  await expect(Effect.runPromise(Effect.flip(deps.readTree(owner, name, "dev")))).resolves.toMatchObject({ code: "unavailable" })
  await expect(Effect.runPromise(Effect.flip(deps.readFile(owner, name, "README", "unknown")))).resolves.toMatchObject({ code: "not_found" })
  await expect(Effect.runPromise(deps.readFile(owner, name, "README", "dev"))).resolves.toMatchObject({ ref: branch, content: "hello" })
  await expect(Effect.runPromise(deps.readFile(owner, name, "binary", "v1"))).resolves.toMatchObject({ ref: tag, content: "\u0000" })
})

test.each([
  ["not_imported", "not_found"], ["not_found", "not_found"], ["not_synced", "not_found"],
  ["too_large", "invalid_params"], ["capacity", "rate_limited"], ["rate_limited", "rate_limited"],
  ["unavailable", "unavailable"],
] as const)("maps mirror refusal %s to tool error %s", async (code, expected) => {
  const refuse = () => Effect.fail(new RepoReads.ReadRefused({ code }))
  const reads: ReturnType<typeof RepoReads.make<unknown, never>> = {
    refs: refuse, tree: refuse, files: refuse, blob: refuse, download: refuse,
  }
  const deps = await Effect.runPromise(makeLiveDeps({
    database: emptySql, reads: Option.some(reads), repoCache: emptyCache, starter: stubStarter,
  }))
  await expect(Effect.runPromise(Effect.flip(deps.listRefs("acme", "project")))).resolves.toMatchObject({ code: expected })
})

test.each([
  ["no_docs", "not_found"], ["not_found", "not_found"], ["page_not_found", "not_found"], ["unavailable", "unavailable"],
] as const)("maps docs source refusal %s to tool error %s", async (code, expected) => {
  const refused = () => Effect.succeed({ _tag: "Refused" as const, code })
  const deps = await Effect.runPromise(makeLiveDeps({
    database: emptySql, reads: Option.none(), repoCache: emptyCache, starter: stubStarter,
    docsSource: { index: refused, page: refused },
  }))
  await expect(Effect.runPromise(Effect.flip(deps.listDocs("acme", "project", "")))).resolves.toMatchObject({ code: expected })
  await expect(Effect.runPromise(Effect.flip(deps.readDoc("acme", "project", "/missing")))).resolves.toMatchObject({ code: expected })
})

test("public GitHub reads distinguish malformed responses from valid empty fields", async () => {
  const responses = new Map<string, Response>()
  const base = "/repos/acme/project"
  const json = (data: unknown) => new Response(JSON.stringify(data))
  const client = HttpClient.make((request) => {
    const url = new URL(request.url)
    const response = responses.get(url.pathname)
    return Effect.succeed(HttpClientResponse.fromWeb(request, response?.clone() ?? new Response(null, { status: 404 })))
  })
  const deps = await Effect.runPromise(makeLiveDeps({
    database: emptySql, reads: Option.none(), repoCache: emptyCache, starter: stubStarter, githubFallbackClient: client,
  }))
  const failure = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(program))
  const run = Effect.runPromise
  const refs = deps.listRefs("acme", "project")
  for (const response of [new Response("{"), json(null), json({ default_branch: "" })]) {
    responses.set(base, response)
    await expect(failure(refs)).resolves.toMatchObject({ code: "unavailable" })
  }
  responses.set(base, json({ default_branch: "main" }))
  responses.set(base + "/git/ref/heads/main", json({ object: { sha: "bad" } }))
  responses.set(base + "/branches", json([]))
  responses.set(base + "/tags", json([]))
  await expect(failure(refs)).resolves.toMatchObject({ code: "unavailable" })

  responses.set(base + "/git/trees/main", json({ truncated: true }))
  await expect(run(deps.readTree("acme", "project"))).resolves.toEqual({ ref: "main", paths: [], truncated: true })
  responses.set(base + "/contents/binary", new Response(Uint8Array.of(0)))
  await expect(run(deps.readFile("acme", "project", "binary"))).resolves.toMatchObject({ content: "\u0000" })

  const issues = deps.listIssues("acme", "project", { state: "all", q: "#3", limit: 1 })
  responses.set(base + "/issues", json({ malformed: true }))
  await expect(failure(issues)).resolves.toMatchObject({ code: "unavailable" })
  responses.set(base + "/issues", json([null, 1, { number: 2 }, { number: 3 }, { number: 3, title: "Second match" }]))
  await expect(run(issues)).resolves.toMatchObject({
    issues: [{ number: 3, title: "", state: "open", author: null, comments: 0, updatedAt: "" }],
    nextCursor: expect.stringMatching(/^gh_/),
  })

  const issue = deps.getIssue("acme", "project", 3)
  responses.set(base + "/issues/3", json({ pull_request: {} }))
  await expect(failure(issue)).resolves.toMatchObject({ code: "not_found" })
  responses.set(base + "/issues/3", json({ labels: ["string", { name: "named" }, null] }))
  responses.set(base + "/issues/3/comments", json({ malformed: true }))
  await expect(failure(issue)).resolves.toMatchObject({ code: "unavailable" })
  responses.set(base + "/issues/3/comments", json([{}, { user: { login: "octo" }, body: "note", created_at: "date" }]))
  await expect(run(issue)).resolves.toMatchObject({
    number: 3, title: "", state: "open", labels: ["string", "named"],
    comments: [{ author: null, body: "", createdAt: "" }, { author: "octo", body: "note", createdAt: "date" }],
  })

  responses.set(base + "/issues/3", json({
    number: 3, title: "Complete issue", state: "closed", user: { login: "octo" }, body: "Details",
    created_at: "yesterday", updated_at: "today",
  }))
  await expect(run(issue)).resolves.toMatchObject({
    title: "Complete issue", state: "closed", author: "octo", body: "Details", createdAt: "yesterday", updatedAt: "today",
  })

  responses.set(base + "/pulls", json({}))
  await expect(run(deps.listPulls("acme", "project", "closed"))).resolves.toEqual([])
  responses.set(base + "/pulls", json([{}]))
  await expect(run(deps.listPulls("acme", "project", "closed"))).resolves.toMatchObject([
    { number: 0, title: "", state: "open", author: null, head: "", base: "", draft: false, updatedAt: "" },
  ])
  const pull = deps.getPull("acme", "project", 3)
  responses.set(base + "/pulls/3", json({}))
  responses.set(base + "/pulls/3/reviews", json({ malformed: true }))
  await expect(failure(pull)).resolves.toMatchObject({ code: "unavailable" })
  responses.set(base + "/pulls/3/reviews", json([{}, { user: { login: "octo" }, state: "APPROVED", body: "review" }]))
  await expect(run(pull)).resolves.toMatchObject({
    number: 3, checks: [], reviews: [{ author: null, state: "", body: "" }, { author: "octo", state: "APPROVED", body: "review" }],
  })
  responses.set(base + "/pulls/3", json({
    number: 3, title: "Complete pull", state: "closed", user: { login: "octo" }, body: "Details",
    head: { ref: "patch", sha: "a".repeat(40) }, base: { ref: "main" }, updated_at: "today", draft: true,
  }))
  await expect(run(pull)).resolves.toMatchObject({
    title: "Complete pull", state: "closed", author: "octo", body: "Details", head: "patch", base: "main", updatedAt: "today", draft: true,
  })
  responses.set(base + "/pulls/3/files", json({}))
  await expect(run(deps.getPullFiles("acme", "project", 3))).resolves.toEqual({ files: [], truncated: false })
  responses.set(base + "/pulls/3/files", json([{}, { filename: "new", previous_filename: "old" }]))
  await expect(run(deps.getPullFiles("acme", "project", 3))).resolves.toMatchObject({
    files: [
      { filename: "", status: "modified", additions: 0, deletions: 0, changes: 0, patch: null },
      { filename: "new", previousFilename: "old" },
    ],
    truncated: false,
  })
})

test("a sparse GitHub search returns a continuation at the next unread page", async () => {
  const pages: string[] = []
  const client = HttpClient.make((request) => {
    const page = new URL(request.url).searchParams.get("page")
    if (page !== null) pages.push(page)
    return Effect.succeed(HttpClientResponse.fromWeb(request, page === "11"
      ? new Response(JSON.stringify([{ number: 81, title: "needle" }]))
      : new Response(JSON.stringify([{ number: 80, title: "hay" }]), {
        headers: { link: '<https://api.github.com/...>; rel="next"' },
      })))
  })
  const deps = await Effect.runPromise(makeLiveDeps({
    database: emptySql, reads: Option.none(), repoCache: emptyCache, starter: stubStarter, githubFallbackClient: client,
  }))
  const query = { state: "open", q: "needle", limit: 6 } as const
  const first = await Effect.runPromise(deps.listIssues("acme", "project", query))
  expect(first).toEqual({ issues: [], nextCursor: expect.stringMatching(/_11_0$/) })
  expect(pages).toEqual(Array.from({ length: 10 }, (_, index) => String(index + 1)))
  const next = await Effect.runPromise(deps.listIssues("acme", "project", { ...query, cursor: first.nextCursor! }))
  expect(next).toMatchObject({ issues: [{ number: 81, title: "needle" }], nextCursor: null })
  await expect(Effect.runPromise(Effect.flip(deps.listIssues("acme", "project", { ...query, cursor: "gh_invalid" }))))
    .resolves.toMatchObject({ code: "invalid_params" })
})

test("GitHub connection errors and interrupted file streams fail as unavailable", async () => {
  const client = HttpClient.make((request) => request.url.includes("contents")
    ? Effect.succeed(HttpClientResponse.fromWeb(request, new Response(new ReadableStream({
      start(controller) { controller.error(new Error("stream lost")) },
    }))))
    : Effect.fail(new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, cause: "connection lost" }),
    })))
  const deps = await Effect.runPromise(makeLiveDeps({
    database: emptySql, reads: Option.none(), repoCache: emptyCache, starter: stubStarter, githubFallbackClient: client,
  }))
  await expect(Effect.runPromise(Effect.flip(deps.readTree("acme", "project", "main"))))
    .resolves.toMatchObject({ code: "unavailable", message: "GitHub request timed out for tree at main" })
  await expect(Effect.runPromise(Effect.flip(deps.readFile("acme", "project", "README", "main"))))
    .resolves.toMatchObject({ code: "unavailable", message: "Could not read GitHub body for README" })
  await expect(Effect.runPromise(Effect.flip(deps.listPulls("acme", "project", "open"))))
    .resolves.toMatchObject({ code: "unavailable", message: "GitHub request timed out for pull requests" })
})

test("database faults remain distinguishable from an absent GitHub client", async () => {
  const database = Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("database offline")))
  const deps = await Effect.runPromise(makeLiveDeps({
    database, reads: Option.none(), repoCache: emptyCache, starter: stubStarter,
  }))
  const failure = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(program))
  await expect(failure(deps.getPullFiles("acme", "project", 2)))
    .resolves.toMatchObject({ code: "unavailable", message: "GitHub client is not configured" })
  for (const [name, request] of [
    ["issue_get", deps.getIssue("acme", "project", 2)],
    ["pull_get", deps.getPull("acme", "project", 2)],
    ["pulls_list", deps.listPulls("acme", "project", "all")],
  ] as const) {
    await expect(Effect.runPromise(Effect.result(request as Effect.Effect<unknown, unknown>)))
      .resolves.toMatchObject({ _tag: "Failure", failure: { code: "unavailable", message: "Database error while executing " + name } })
  }
})

test("write admission surfaces lost permission and durable starter errors", async () => {
  const args = {
    owner: "acme", name: "project", personId: "author", login: "author",
    writeId: crypto.randomUUID(), agentLabel: "author (agent)", title: "Issue", body: "Details",
  }
  const store = vi.spyOn(Store, "insertWrite")
  try {
    const deps = await Effect.runPromise(makeLiveDeps({
      database: emptySql,
      reads: Option.none(),
      repoCache: emptyCache,
      starter: { start: () => Effect.fail(new StartUnavailable({ errorCode: "offline" })) },
    }))
    store.mockReturnValueOnce(Effect.succeed({ kind: "stale" }))
    await expect(Effect.runPromise(Effect.flip(deps.createIssue(args)))).resolves.toMatchObject({ code: "forbidden" })
    store.mockReturnValueOnce(Effect.succeed({ kind: "inserted", txid: 1 }))
    await expect(Effect.runPromise(Effect.flip(deps.createIssue(args)))).resolves.toMatchObject({
      code: "unavailable", message: "Could not start durable GitHub write",
    })
  } finally {
    store.mockRestore()
  }
})

test("unfiltered docs list caps the response and preserves optional page metadata", async () => {
  const index = {
    title: "Manual", url: "https://docs.example/llms.txt",
    pages: Array.from({ length: MAX_LISTED + 1 }, (_, i) => ({
      title: "Page " + i, path: "/page/" + i, url: "https://docs.example/page/" + i,
      ...(i === 0 ? { description: "Start here" } : { section: "Reference" }),
    })),
  }
  const deps = await Effect.runPromise(makeLiveDeps({
    database: emptySql, reads: Option.none(), repoCache: emptyCache, starter: stubStarter,
    docsSource: {
      index: () => Effect.succeed({ _tag: "Index", source: "declared", cached: false, index }),
      page: () => Effect.succeed({ _tag: "Refused", code: "page_not_found" }),
    },
  }))
  const result = await Effect.runPromise(deps.listDocs("acme", "project", " "))
  expect(result.truncated).toBe(true)
  expect(result.pages).toHaveLength(MAX_LISTED)
  expect(result.pages[0]).toEqual({ title: "Page 0", path: "/page/0", description: "Start here" })
  expect(result.pages[1]).toEqual({ title: "Page 1", path: "/page/1", section: "Reference" })
})

test("a historical completed pull check is returned with a success conclusion", async () => {
  const database = Layer.succeed(SqlClient.SqlClient, ((query: TemplateStringsArray) => {
    const statement = query.join("?")
    if (statement.includes("FROM runs")) return Effect.succeed([{ flow: "verify", status: "completed" }])
    if (statement.includes("FROM pulls")) return Effect.succeed([{
      item_id: "github/acme/project#1", number: 1, title: "Pull", state: "open", author_login: null,
      body: "", head_ref: "patch", head_sha: "a".repeat(40), base_ref: "main", draft: false, updated_at: "",
    }])
    return Effect.succeed([])
  }) as unknown as SqlClient.SqlClient)
  const deps = await Effect.runPromise(makeLiveDeps({
    database, reads: Option.none(), repoCache: emptyCache, starter: stubStarter,
  }))
  await expect(Effect.runPromise(deps.getPull("acme", "project", 1))).resolves.toMatchObject({
    checks: [{ name: "verify", status: "completed", conclusion: "success" }],
  })
})
