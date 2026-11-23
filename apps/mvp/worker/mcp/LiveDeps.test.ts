import { ImmutableCache } from "@smthrs/artifacts"
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import { makeLiveDeps } from "./LiveDeps.ts"

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
