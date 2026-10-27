import { ConfigProvider, Effect, Exit, Fiber, Layer, Option, Redacted, Stream } from "effect"
import { beforeAll, describe, expect, test } from "vitest"
import { CodeStorage } from "../src/index.ts"
import {
  BASE,
  brokenBody,
  codeStorage,
  decodeClaims,
  growth,
  httpClient,
  keyPair,
  longBody,
  ORG,
  telemetry
} from "./fixtures.ts"

let pem: string
let publicKey: CryptoKey

beforeAll(async () => {
  ;({ pem, publicKey } = await keyPair())
})

/** The client over a fresh scripted service, with everything it records. */
const harness = () => {
  const service = codeStorage(publicKey)
  const recorded = telemetry()
  const layer = CodeStorage.CodeStorage.layer({ org: ORG, key: Redacted.make(pem) }).pipe(
    Layer.provide(httpClient(service.fetch))
  )
  const run = <A>(f: (client: CodeStorage.Client) => Effect.Effect<A, CodeStorage.CodeStorageError>) =>
    Effect.runPromise(recorded.provide(CodeStorage.CodeStorage.use(f).pipe(Effect.provide(layer))))
  const fail = <A>(f: (client: CodeStorage.Client) => Effect.Effect<A, CodeStorage.CodeStorageError>) =>
    Effect.runPromise(
      recorded.provide(Effect.flip(CodeStorage.CodeStorage.use(f)).pipe(Effect.provide(layer)))
    )
  return { ...service, ...recorded, layer, run, fail }
}

const README = new TextEncoder().encode("# tinyhttp\n")

describe("createRepo", () => {
  test("mirrors a public GitHub repository with a token for that repository and repo:write only", async () => {
    const h = harness()
    const created = await h.run((client) =>
      client.createRepo({
        name: "github/octocat/spoon-knife",
        defaultBranch: "main",
        github: { owner: "octocat", name: "Spoon-Knife" }
      })
    )
    expect(created).toEqual({ name: "github/octocat/spoon-knife", created: true })
    const [request] = h.seen
    expect(request!.method).toBe("POST")
    expect(request!.url.href).toBe(`${BASE}/api/repos`)
    expect(request!.body).toEqual({
      repo_name: "github/octocat/spoon-knife",
      default_branch: "main",
      upstream: { provider: "github", owner: "octocat", name: "Spoon-Knife", access: "public" }
    })
    expect(request!.claims).toMatchObject({
      iss: ORG,
      sub: "@smthrs/effect-code-storage",
      repo: "github/octocat/spoon-knife",
      scopes: ["repo:write"]
    })
    expect(request!.claims!.exp - request!.claims!.iat).toBe(300)
    expect(h.repos.get("github/octocat/spoon-knife")).toMatchObject({
      upstream: { owner: "octocat", name: "Spoon-Knife" }
    })
  })

  test("is idempotent by name: the same create again answers created false", async () => {
    const h = harness()
    const options = { name: "github/octocat/spoon-knife", github: { owner: "octocat", name: "Spoon-Knife" } }
    await h.run((client) => client.createRepo(options))
    expect(await h.run((client) => client.createRepo(options))).toEqual({ name: options.name, created: false })
  })

  test("sends only the name for a plain repository", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "scratch" }))
    expect(h.seen[0]!.body).toEqual({ repo_name: "scratch" })
    expect(h.repos.get("scratch")!.defaultBranch).toBe("main")
  })

  test("a name that exists with another upstream fails with conflict, which isn't transient", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "x", github: { owner: "a", name: "b" } }))
    const error = await h.fail((client) => client.createRepo({ name: "x", github: { owner: "c", name: "d" } }))
    expect(error).toMatchObject({ operation: "createRepo", code: "conflict", status: 409 })
    expect(CodeStorage.isTransient(error)).toBe(false)
  })

  test("an answer without repo_name is invalid_response", async () => {
    const h = harness()
    h.faults.push(Response.json({ message: "created" }, { status: 201 }))
    expect(await h.fail((client) => client.createRepo({ name: "x" }))).toMatchObject({
      code: "invalid_response",
      status: 201
    })
  })
})

describe("pullUpstream", () => {
  test("posts to the repository's upstream with git:write, its slashes encoded into one segment", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "github/o/n", github: { owner: "o", name: "n" } }))
    await h.run((client) => client.pullUpstream("github/o/n"))
    const pull = h.seen[1]!
    expect(pull.method).toBe("POST")
    expect(pull.url.pathname).toBe("/api/repos/github%2Fo%2Fn/upstream/pull")
    expect(pull.claims).toMatchObject({ repo: "github/o/n", scopes: ["git:write"] })
  })

  test("while a sync runs it fails with sync_in_progress, which is transient", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "r" }))
    h.repos.get("r")!.syncing = 1
    const error = await h.fail((client) => client.pullUpstream("r"))
    expect(error).toMatchObject({ operation: "pullUpstream", code: "sync_in_progress", status: 409 })
    expect(CodeStorage.isTransient(error)).toBe(true)
  })
})

describe("listFiles", () => {
  const seeded = async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "r" }))
    h.repos.get("r")!.files = { "README.md": README, "src/index.ts": README, "src/router.ts": README }
    return h
  }

  test("pages through the tree with every option on the query and git:read only", async () => {
    const h = await seeded()
    const first = await h.run((client) => client.listFiles("r", { ref: "abc", path: "", recursive: true, limit: 2 }))
    expect(first).toEqual({
      ref: "abc",
      paths: ["README.md", "src/index.ts"],
      entries: [
        { path: "README.md", type: "blob", mode: "100644" },
        { path: "src/index.ts", type: "blob", mode: "100644" }
      ],
      nextCursor: "2",
      bytesRead: expect.any(Number)
    })
    expect(Object.fromEntries(h.seen[1]!.url.searchParams)).toEqual({
      ref: "abc",
      path: "",
      recursive: "true",
      limit: "2"
    })
    expect(h.seen[1]!.claims!.scopes).toEqual(["git:read"])
    const second = await h.run((client) => client.listFiles("r", { cursor: first.nextCursor, limit: 2 }))
    expect(second).toMatchObject({ paths: ["src/router.ts"], nextCursor: undefined })
    expect(h.seen[2]!.url.searchParams.get("cursor")).toBe("2")
  })

  test("with no options it sends no query", async () => {
    const h = await seeded()
    await h.run((client) => client.listFiles("r"))
    expect(h.seen[1]!.url.search).toBe("")
  })

  test("more pages with no cursor, a body that isn't the schema, and a body that isn't JSON are invalid_response", async () => {
    const h = await seeded()
    h.faults.push(Response.json({ paths: [], entries: [], ref: "main", has_more: true }))
    h.faults.push(Response.json({ paths: "nope" }))
    h.faults.push(new Response("<html>", { status: 200 }))
    for (let index = 0; index < 3; index++) {
      expect(await h.fail((client) => client.listFiles("r"))).toMatchObject({ code: "invalid_response", status: 200 })
    }
  })

  test("an answer over 8 MiB is not read past the cap and is invalid_response", async () => {
    const h = await seeded()
    h.faults.push(new Response(longBody(8 * 1024 * 1024 + 1)))
    expect(await h.fail((client) => client.listFiles("r"))).toMatchObject({ code: "invalid_response" })
  })

  test("an answer that breaks off is transport", async () => {
    const h = await seeded()
    h.faults.push(new Response(brokenBody("{\"paths\":")))
    expect(await h.fail((client) => client.listFiles("r"))).toMatchObject({ code: "transport", status: 200 })
  })
})

describe("readFile", () => {
  test("streamFile retains original bytes, scopes the read token and classifies a broken stream", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "r" }))
    h.repos.get("r")!.files["large.bin"] = new Uint8Array(600 * 1024).fill(97)
    const file = await h.run((client) =>
      client.streamFile("r", { path: "large.bin", ref: "main", namespace: "ephemeral" })
    )
    expect(h.count(CodeStorage.bytesRead, { operation: "readFile" })).toBe(0)
    expect(h.seen.at(-1)!.url.searchParams.get("ephemeral")).toBe("true")
    const chunks = await Effect.runPromise(Stream.runCollect(file.stream))
    expect(Array.from(chunks).reduce((sum, chunk) => sum + chunk.length, 0)).toBe(600 * 1024)
    expect(file.blobSha).toMatch(/^[0-9a-f]{40}$/)
    await h.run((client) => client.streamFile("r", { path: "large.bin" }))
    await h.run((client) => client.streamFile("r", { path: "large.bin", namespace: "default" }))
    h.faults.push(new Response(brokenBody("bytes")))
    const broken = await h.run((client) => client.streamFile("r", { path: "large.bin" }))
    expect(await Effect.runPromise(Effect.flip(Stream.runDrain(broken.stream)))).toMatchObject({
      code: "transport",
      status: 200
    })
    h.faults.push(new Response(longBody(100 * 1024 * 1024, 1024)))
    const cancellable = await h.run((client) => client.streamFile("r", { path: "large.bin" }))
    const first = await Effect.runPromise(Stream.runCollect(Stream.take(cancellable.stream, 1)))
    expect(Array.from(first).map((chunk) => chunk.length)).toEqual([1024])
  })
  const seeded = async (files: Record<string, Uint8Array>) => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "r" }))
    h.repos.get("r")!.files = files
    return h
  }

  test("reads the bytes at a ref, with the blob id", async () => {
    const h = await seeded({ "README.md": README })
    const file = await h.run((client) => client.readFile("r", { path: "README.md", ref: "abc", maxBytes: 1024 }))
    expect(new TextDecoder().decode(file.bytes)).toBe("# tinyhttp\n")
    expect(file.blobSha).toBe("b".repeat(40))
    expect(Object.fromEntries(h.seen[1]!.url.searchParams)).toEqual({ path: "README.md", ref: "abc" })
  })

  test("a file exactly at the cap is read whole", async () => {
    const h = await seeded({ "README.md": README })
    const file = await h.run((client) => client.readFile("r", { path: "README.md", maxBytes: README.length }))
    expect(file.bytes.length).toBe(README.length)
  })

  test("a declared size over the cap fails too_large with the size, before reading", async () => {
    const h = await seeded({ "big.bin": new Uint8Array(2048) })
    expect(await h.fail((client) => client.readFile("r", { path: "big.bin", maxBytes: 1024 }))).toMatchObject({
      operation: "readFile",
      code: "too_large",
      size: 2048
    })
  })

  test("an undeclared body over the cap stops at the cap and fails too_large", async () => {
    const h = await seeded({})
    h.faults.push(new Response(longBody(1024 * 1024)))
    const error = await h.fail((client) => client.readFile("r", { path: "big.bin", maxBytes: 1000 }))
    expect(error).toMatchObject({ code: "too_large", status: 200 })
    expect(error.size).toBeUndefined()
  })

  test("reading a body costs time linear in its size, however finely the network cuts it", async () => {
    const h = await seeded({})
    const read = async (size: number) => {
      h.faults.push(new Response(longBody(size, 1024)))
      const file = await h.run((client) => client.readFile("r", { path: "big.bin", maxBytes: size }))
      expect(file.bytes.length).toBe(size)
    }
    // 512 KiB, then 2 MiB, in 1 KiB chunks: linear grows about 4x; re-joining every chunk read so far grows about 16x.
    expect(await growth(read, 512 * 1024)).toBeLessThan(8)
  })

  test("a missing file is not_found; a body that breaks off is transport", async () => {
    const h = await seeded({})
    expect(await h.fail((client) => client.readFile("r", { path: "nope", maxBytes: 10 }))).toMatchObject({
      code: "not_found",
      status: 404
    })
    h.faults.push(new Response(brokenBody("abc")))
    expect(await h.fail((client) => client.readFile("r", { path: "x", maxBytes: 10 }))).toMatchObject({
      code: "transport"
    })
  })
})

describe("listCommits", () => {
  test("maps each commit and follows the cursor", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "r" }))
    h.repos.get("r")!.commits = [{
      sha: "a".repeat(40),
      parent_shas: ["c".repeat(40)],
      message: "fix: preserve response headers\n\nbody",
      author_name: "Cora",
      author_email: "cora@example.com",
      committer_name: "Cora",
      committer_email: "cora@example.com",
      date: "2026-10-18T10:00:00Z"
    }]
    const page = await h.run((client) => client.listCommits("r", { ref: "main", path: "src", limit: 1 }))
    expect(page).toEqual({
      commits: [{
        sha: "a".repeat(40),
        parentShas: ["c".repeat(40)],
        message: "fix: preserve response headers\n\nbody",
        authorName: "Cora",
        authorEmail: "cora@example.com",
        date: "2026-10-18T10:00:00Z"
      }],
      nextCursor: undefined,
      bytesRead: expect.any(Number)
    })
    expect(Object.fromEntries(h.seen[1]!.url.searchParams)).toEqual({ ref: "main", path: "src", limit: "1" })
    h.faults.push(Response.json({ commits: [], has_more: true, next_cursor: "n2" }))
    expect(await h.run((client) => client.listCommits("r", { cursor: "n1" }))).toEqual({
      commits: [],
      nextCursor: "n2",
      bytesRead: expect.any(Number)
    })
    await h.run((client) => client.listCommits("r"))
    expect(h.seen[3]!.url.search).toBe("")
  })
})

describe("createBranch", () => {
  test("creates a branch at the commit another names, with a git:write token for that repository", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "acme/r" }))
    h.repos.get("acme/r")!.branches = [{ name: "main", head_sha: "a".repeat(40), created_at: "2026-10-18T10:00:00Z" }]
    const created = await h.run((client) => client.createBranch("acme/r", { branch: "maya/k3f9q2", from: "main" }))
    expect(created).toEqual({ branch: "maya/k3f9q2", sha: "a".repeat(40) })
    const request = h.seen[1]!
    expect([request.method, request.url.pathname]).toEqual(["POST", "/api/repos/acme%2Fr/branches/create"])
    expect(request.body).toEqual({ base_ref: "main", target_branch: "maya/k3f9q2" })
    expect(request.claims).toMatchObject({ repo: "acme/r", scopes: ["git:write"] })
    expect(h.repos.get("acme/r")!.branches.map((branch) => branch.name)).toEqual(["main", "maya/k3f9q2"])
    expect(h.count(CodeStorage.requests, { operation: "createBranch", outcome: "ok" })).toBe(1)
  })

  test("a commit Code Storage doesn't name is undefined; a branch that exists is conflict; a missing ref ref_not_found", async () => {
    const h = harness()
    h.faults.push(Response.json({ message: "created", target_branch: "b", target_is_ephemeral: false }))
    expect(await h.run((client) => client.createBranch("acme/r", { branch: "b", from: "main" }))).toEqual({
      branch: "b",
      sha: undefined
    })
    await h.run((client) => client.createRepo({ name: "acme/r" }))
    h.repos.get("acme/r")!.branches = [{ name: "main", head_sha: "a".repeat(40), created_at: "2026-10-18T10:00:00Z" }]
    await h.run((client) => client.createBranch("acme/r", { branch: "b", from: "main" }))
    expect(await h.fail((client) => client.createBranch("acme/r", { branch: "b", from: "main" }))).toMatchObject({
      operation: "createBranch",
      code: "conflict",
      status: 409
    })
    expect(await h.fail((client) => client.createBranch("acme/r", { branch: "c", from: "nope" }))).toMatchObject({
      operation: "createBranch",
      code: "ref_not_found",
      status: 404
    })
    h.faults.push(Response.json({ message: "created" }))
    expect((await h.fail((client) => client.createBranch("acme/r", { branch: "d", from: "main" }))).code).toBe(
      "invalid_response"
    )
  })

  test("force moves a branch that exists to the commit another names, fast-forward or not", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "acme/r" }))
    const [older, newer] = ["a".repeat(40), "b".repeat(40)]
    h.repos.get("acme/r")!.branches = [
      { name: "main", head_sha: older, created_at: "2026-10-18T10:00:00Z" },
      { name: "try-1-0123456789ab", head_sha: newer, created_at: "2026-10-18T10:00:00Z" }
    ]
    await h.run((client) => client.createBranch("acme/r", { branch: "try-1", from: "main" }))
    const moved = await h.run((client) => client.createBranch("acme/r", { branch: "try-1", from: newer, force: true }))
    expect(moved).toEqual({ branch: "try-1", sha: newer })
    expect(h.seen.at(-1)!.body).toEqual({ base_ref: newer, target_branch: "try-1", force: true })
    // Moving it to where it is changes nothing and answers the same.
    expect(await h.run((client) => client.createBranch("acme/r", { branch: "try-1", from: newer, force: true })))
      .toEqual(
        moved
      )
    // Back, which no fast-forward allows.
    await h.run((client) => client.createBranch("acme/r", { branch: "try-1", from: older, force: true }))
    expect(h.repos.get("acme/r")!.branches.find((branch) => branch.name === "try-1")!.head_sha).toBe(older)
    // A commit it can't resolve is still ref_not_found, and nothing moves.
    expect(
      await h.fail((client) => client.createBranch("acme/r", { branch: "try-1", from: "c".repeat(40), force: true }))
    ).toMatchObject({ code: "ref_not_found", status: 404 })
    expect(h.repos.get("acme/r")!.branches.find((branch) => branch.name === "try-1")!.head_sha).toBe(older)
    // `force: false` is the default: a branch that exists is conflict.
    expect(await h.fail((client) => client.createBranch("acme/r", { branch: "try-1", from: "main", force: false })))
      .toMatchObject({ code: "conflict" })
    expect(h.seen.at(-1)!.body).toEqual({ base_ref: "main", target_branch: "try-1" })
  })
})

describe("listBranches", () => {
  test("maps each branch's head and pages with the cursor, git:read only", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "acme/r" }))
    h.repos.get("acme/r")!.branches = [
      { name: "main", head_sha: "a".repeat(40), created_at: "2026-10-18T10:00:00Z" },
      { name: "feature/x", head_sha: "b".repeat(40), created_at: "2026-10-19T10:00:00Z" }
    ]
    const first = await h.run((client) => client.listBranches("acme/r", { limit: 1 }))
    expect(first).toEqual({
      branches: [{ name: "main", sha: "a".repeat(40), createdAt: "2026-10-18T10:00:00Z" }],
      nextCursor: "1",
      bytesRead: expect.any(Number)
    })
    expect(h.seen[1]!.url.pathname).toBe("/api/repos/acme%2Fr/branches")
    expect(h.seen[1]!.claims!.scopes).toEqual(["git:read"])
    expect(Object.fromEntries(h.seen[1]!.url.searchParams)).toEqual({ limit: "1" })
    const second = await h.run((client) => client.listBranches("acme/r", { cursor: first.nextCursor, limit: 1 }))
    expect(second.branches.map((branch) => branch.name)).toEqual(["feature/x"])
    expect(second.nextCursor).toBeUndefined()
    await h.run((client) => client.listBranches("acme/r"))
    expect(h.seen[3]!.url.search).toBe("")
  })

  test("more pages with no cursor, or a body outside the schema, is invalid_response; a missing repository not_found", async () => {
    const h = harness()
    h.faults.push(Response.json({ branches: [], has_more: true }), Response.json({ branches: [{ name: "main" }] }))
    expect(await h.fail((client) => client.listBranches("r"))).toMatchObject({
      operation: "listBranches",
      code: "invalid_response",
      status: 200
    })
    expect((await h.fail((client) => client.listBranches("r"))).code).toBe("invalid_response")
    expect(await h.fail((client) => client.listBranches("gone"))).toMatchObject({
      operation: "listBranches",
      code: "repository_not_found",
      status: 404
    })
  })
})

describe("listTags", () => {
  test("maps each tag's commit and pages with the cursor, git:read only", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "r" }))
    h.repos.get("r")!.tags = [{ name: "v1.0.0", sha: "c".repeat(40) }, { name: "v1.1.0", sha: "d".repeat(40) }]
    const first = await h.run((client) => client.listTags("r", { limit: 1 }))
    expect(first).toEqual({
      tags: [{ name: "v1.0.0", sha: "c".repeat(40) }],
      nextCursor: "1",
      bytesRead: expect.any(Number)
    })
    expect(h.seen[1]!.url.pathname).toBe("/api/repos/r/tags")
    expect(h.seen[1]!.claims!.scopes).toEqual(["git:read"])
    const second = await h.run((client) => client.listTags("r", { cursor: "1" }))
    expect(second).toEqual({
      tags: [{ name: "v1.1.0", sha: "d".repeat(40) }],
      nextCursor: undefined,
      bytesRead: expect.any(Number)
    })
    expect(Object.fromEntries(h.seen[2]!.url.searchParams)).toEqual({ cursor: "1" })
    await h.run((client) => client.listTags("r"))
    expect(h.seen[3]!.url.search).toBe("")
  })

  test("more pages with no cursor is invalid_response; a sync still running is sync_in_progress, which is transient", async () => {
    const h = harness()
    h.faults.push(Response.json({ tags: [], has_more: true }))
    expect(await h.fail((client) => client.listTags("r"))).toMatchObject({
      operation: "listTags",
      code: "invalid_response"
    })
    await h.run((client) => client.createRepo({ name: "r" }))
    h.repos.get("r")!.syncing = 1
    const syncing = await h.fail((client) => client.listTags("r"))
    expect(syncing.code).toBe("sync_in_progress")
    expect(CodeStorage.isTransient(syncing)).toBe(true)
  })
})

describe("failures", () => {
  test("a rate limit carries Retry-After, in seconds or as a date, and is transient", async () => {
    const h = harness()
    h.faults.push(
      new Response(JSON.stringify({ code: "rate_limited" }), { status: 429, headers: { "retry-after": "3" } })
    )
    const seconds = await h.fail((client) => client.listFiles("r"))
    expect(seconds).toMatchObject({ code: "rate_limited", status: 429, retryAfterMillis: 3000 })
    expect(CodeStorage.isTransient(seconds)).toBe(true)
    // `@smthrs/flow`'s RetryPolicy.decide waits an own data property named `retryAfterMillis` instead of its backoff.
    expect(Object.getOwnPropertyDescriptor(seconds, "retryAfterMillis")).toMatchObject({ value: 3000 })

    h.faults.push(
      new Response(null, { status: 429, headers: { "retry-after": new Date(Date.now() + 60_000).toUTCString() } })
    )
    const dated = await h.fail((client) => client.listFiles("r"))
    expect(dated.retryAfterMillis).toBeGreaterThan(55_000)
    expect(dated.retryAfterMillis).toBeLessThanOrEqual(60_000)

    h.faults.push(new Response(null, { status: 429, headers: { "retry-after": "soon" } }))
    expect((await h.fail((client) => client.listFiles("r"))).retryAfterMillis).toBeUndefined()
    h.faults.push(new Response(null, { status: 429, headers: { "retry-after": "Thu, 01 Jan 1970 00:00:00 GMT" } }))
    expect((await h.fail((client) => client.listFiles("r"))).retryAfterMillis).toBe(0)
  })

  test("a status with no code takes its generic code; a status with none known is http_<status>", async () => {
    const h = harness()
    h.faults.push(new Response(null, { status: 503 }), new Response("teapot", { status: 418 }))
    const unavailable = await h.fail((client) => client.listFiles("r"))
    expect(unavailable).toMatchObject({ code: "service_unavailable", status: 503 })
    expect(CodeStorage.isTransient(unavailable)).toBe(true)
    const teapot = await h.fail((client) => client.listFiles("r"))
    expect(teapot).toMatchObject({ code: "http_418", status: 418 })
    expect(CodeStorage.isTransient(teapot)).toBe(false)
  })

  test("a code that isn't an identifier, and a problem body over 16 KiB, fall back to the generic code", async () => {
    const h = harness()
    h.faults.push(Response.json({ code: "Repository has SECRET text" }, { status: 400 }))
    h.faults.push(new Response(longBody(17 * 1024), { status: 404 }))
    h.faults.push(new Response(brokenBody("{"), { status: 500 }))
    expect(await h.fail((client) => client.listFiles("r"))).toMatchObject({ code: "bad_request" })
    expect(await h.fail((client) => client.listFiles("r"))).toMatchObject({ code: "not_found" })
    expect(await h.fail((client) => client.listFiles("r"))).toMatchObject({ code: "internal_error" })
  })

  test("no answer at all is transport, with no status, and transient", async () => {
    const h = harness()
    h.faults.push("throw")
    const error = await h.fail((client) => client.readFile("r", { path: "a", maxBytes: 1 }))
    expect(error).toMatchObject({ operation: "readFile", code: "transport" })
    expect(error.status).toBeUndefined()
    expect(CodeStorage.isTransient(error)).toBe(true)
    expect(error.message).toBe("Code Storage readFile failed: transport")
  })

  test("the error, its message and the telemetry never carry the provider's text, the key or the token", async () => {
    const h = harness()
    h.faults.push(Response.json({ code: "repository_not_found", detail: "SENTINEL-DETAIL" }, { status: 404 }))
    const error = await h.fail((client) => client.listFiles("github/o/n"))
    expect(error.message).toBe("Code Storage listFiles failed: repository_not_found (404)")
    const token = h.seen[0]!.authorization!.slice("Bearer ".length)
    const everything = `${JSON.stringify(error)} ${error.message} ${h.recorded()}`
    expect(everything).not.toContain("SENTINEL-DETAIL")
    expect(everything).not.toContain(token)
    expect(everything).not.toContain(pem.split("\n")[1]!)
  })
})

describe("error codes", () => {
  test("an unknown code is its status's generic code, and the error keeps the server's code for diagnosis", async () => {
    const h = harness()
    h.faults.push(
      Response.json({ code: "org_quota_frozen" }, { status: 429, headers: { "retry-after": "7" } }),
      Response.json({ code: "brand_new_conflict" }, { status: 409 })
    )
    const limited = await h.fail((client) => client.listFiles("r"))
    expect(limited).toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterMillis: 7000,
      unknownCode: "org_quota_frozen"
    })
    expect(CodeStorage.isTransient(limited)).toBe(true)
    expect(limited.message).toBe("Code Storage listFiles failed: rate_limited (429, unknown code org_quota_frozen)")
    expect(h.count(CodeStorage.requests, { operation: "listFiles", outcome: "rate_limited" })).toBe(1)
    const conflict = await h.fail((client) => client.listFiles("r"))
    expect(conflict).toMatchObject({ code: "conflict", status: 409, unknownCode: "brand_new_conflict" })
    expect(CodeStorage.isTransient(conflict)).toBe(false)
  })

  test("documented codes stand as sent, generic or specific, on any status", async () => {
    const h = harness()
    const sent: ReadonlyArray<readonly [number, string]> = [
      [409, "repository_thawing"],
      [422, "github_repository_inaccessible"],
      [403, "authentication_unavailable"],
      [429, "rate_limited"],
      [400, "repo_name_mismatch"]
    ]
    for (const [status, code] of sent) h.faults.push(Response.json({ code }, { status }))
    for (const [status, code] of sent) {
      const error = await h.fail((client) => client.listFiles("r"))
      expect(error).toMatchObject({ code, status })
      expect(error.unknownCode).toBeUndefined()
      expect(error.message).toBe(`Code Storage listFiles failed: ${code} (${status})`)
    }
  })

  test("on a status with no generic code in the table, the server's code stands: it is that status's own", async () => {
    const h = harness()
    h.faults.push(Response.json({ code: "im_a_teapot" }, { status: 418 }))
    const error = await h.fail((client) => client.listFiles("r"))
    expect(error).toMatchObject({ code: "im_a_teapot", status: 418 })
    expect(error.unknownCode).toBeUndefined()
  })
})

describe("bytes read", () => {
  const size = (text: string) => new TextEncoder().encode(text).length

  test("a page reports the bytes its answer took, and code_storage_bytes_read counts them by operation", async () => {
    const h = harness()
    const listing = JSON.stringify({
      paths: ["a"],
      ref: "main",
      entries: [{ path: "a", type: "blob", mode: "100644" }],
      has_more: false
    })
    const history = JSON.stringify({ commits: [], has_more: false })
    const created = JSON.stringify({ repo_name: "r" })
    h.faults.push(new Response(listing), new Response(history), new Response(created, { status: 201 }))
    const files = await h.run((client) => client.listFiles("r"))
    const commits = await h.run((client) => client.listCommits("r"))
    await h.run((client) => client.createRepo({ name: "r" }))
    expect(files.bytesRead).toBe(size(listing))
    expect(commits.bytesRead).toBe(size(history))
    expect(h.count(CodeStorage.bytesRead, { operation: "listFiles" })).toBe(size(listing))
    expect(h.count(CodeStorage.bytesRead, { operation: "listCommits" })).toBe(size(history))
    expect(h.count(CodeStorage.bytesRead, { operation: "createRepo" })).toBe(size(created))
  })

  test("a file counts its bytes, and an error counts the problem body it read", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "r" }))
    h.repos.get("r")!.files = { "README.md": README }
    await h.run((client) => client.readFile("r", { path: "README.md", maxBytes: 1024 }))
    const problem = JSON.stringify({ code: "not_found", detail: "no such file" })
    h.faults.push(new Response(problem, { status: 404 }))
    await h.fail((client) => client.readFile("r", { path: "nope", maxBytes: 1024 }))
    expect(h.count(CodeStorage.bytesRead, { operation: "readFile" })).toBe(README.length + size(problem))
  })

  test("counts what arrived: a body cut at the cap, and one that broke off, but nothing for a declared-too-large file", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "r" }))
    h.repos.get("r")!.files = { "big.bin": new Uint8Array(2048) }
    await h.fail((client) => client.readFile("r", { path: "big.bin", maxBytes: 1024 }))
    expect(h.count(CodeStorage.bytesRead, { operation: "readFile" })).toBe(0)

    h.faults.push(new Response(longBody(1024 * 1024)))
    await h.fail((client) => client.readFile("r", { path: "x", maxBytes: 1000 }))
    const cut = h.count(CodeStorage.bytesRead, { operation: "readFile" })
    expect(cut).toBeGreaterThanOrEqual(1000)
    expect(cut).toBeLessThan(1024 * 1024)

    h.faults.push(new Response(brokenBody("{\"paths\":")))
    await h.fail((client) => client.listFiles("r"))
    expect(h.count(CodeStorage.bytesRead, { operation: "listFiles" })).toBe(size("{\"paths\":"))
  })
})

describe("telemetry", () => {
  test("each call is one span naming only the repository, and one count by operation and outcome", async () => {
    const h = harness()
    await h.run((client) => client.createRepo({ name: "r" }))
    await h.fail((client) => client.readFile("r", { path: "missing", maxBytes: 1 }))
    const span = h.spans.find((each) => each.name === "CodeStorage.createRepo")!
    expect(Object.fromEntries(span.attributes)).toEqual({ "code_storage.repo": "r" })
    expect(h.spans.find((each) => each.name === "CodeStorage.readFile")).toBeDefined()
    expect(h.count(CodeStorage.requests, { operation: "createRepo", outcome: "ok" })).toBe(1)
    expect(h.count(CodeStorage.requests, { operation: "readFile", outcome: "not_found" })).toBe(1)
    // Effect's HTTP client span is the call's child and names the route; no header reaches it.
    const client = h.spans.find((each) => each.attributes.get("http.request.method") === "POST")!
    expect(client.attributes.get("url.full")).toBe(`${BASE}/api/repos`)
    expect(Option.getOrThrow(client.parent).spanId).toBe(span.spanId)
    expect([...client.attributes.keys()].filter((name) => name.includes("header"))).toEqual([])
  })

  test("a call interrupted mid-flight counts as interrupted", async () => {
    const h = harness()
    let started!: () => void
    const waiting = new Promise<void>((resolve) => (started = resolve))
    h.faults.push((request) =>
      new Promise<Response>((_, reject) => {
        started()
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
      })
    )
    await Effect.runPromise(h.provide(
      Effect.gen(function*() {
        const client = yield* CodeStorage.CodeStorage
        const fiber = yield* Effect.forkChild(client.listFiles("r"))
        yield* Effect.promise(() => waiting)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(h.layer))
    ))
    expect(h.count(CodeStorage.requests, { operation: "listFiles", outcome: "interrupted" })).toBe(1)
  })
})

describe("layers", () => {
  test("a key that doesn't import fails the layer with invalid_key", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        CodeStorage.CodeStorage,
        CodeStorage.CodeStorage.layer({ org: ORG, key: Redacted.make("not a key") }).pipe(
          Layer.provide(httpClient(globalThis.fetch))
        )
      )
    )
    expect(exit).toEqual(Exit.fail(new CodeStorage.CodeStorageError({ operation: "configure", code: "invalid_key" })))
  })

  test("layerConfig reads the organization, the key with escaped newlines, and the API origin", async () => {
    const service = codeStorage(publicKey)
    const provider = ConfigProvider.fromUnknown({
      CODE_STORAGE_ORG: ORG,
      CODE_STORAGE_KEY: pem.replaceAll("\n", "\\n"),
      CODE_STORAGE_API_URL: "https://storage.internal"
    })
    const seen = await Effect.runPromise(
      Effect.flatMap(CodeStorage.CodeStorage, (client) => Effect.flip(client.listFiles("r"))).pipe(
        Effect.provide(CodeStorage.CodeStorage.layerConfig.pipe(Layer.provide(httpClient(service.fetch)))),
        Effect.provide(ConfigProvider.layer(provider))
      )
    )
    expect(seen).toMatchObject({ code: "route_not_found", status: 404 })
    expect(service.seen[0]!.url.origin).toBe("https://storage.internal")
  })

  test("without an API origin it calls api.<org>.code.storage", async () => {
    const service = codeStorage(publicKey)
    const provider = ConfigProvider.fromUnknown({ CODE_STORAGE_ORG: ORG, CODE_STORAGE_KEY: pem })
    await Effect.runPromise(
      Effect.flatMap(CodeStorage.CodeStorage, (client) => client.createRepo({ name: "r" })).pipe(
        Effect.provide(CodeStorage.CodeStorage.layerConfig.pipe(Layer.provide(httpClient(service.fetch)))),
        Effect.provide(ConfigProvider.layer(provider))
      )
    )
    expect(service.seen[0]!.url.origin).toBe(BASE)
  })
})

describe("gitRemote", () => {
  test("is the repository's git URL with a five-minute git:read token for it as Basic t:<token>", async () => {
    const h = harness()
    const upstream = await h.run((client) => client.gitRemote("github/octocat/spoon-knife"))
    expect(upstream.url).toBe(`https://${ORG}.code.storage/github/octocat/spoon-knife.git`)
    const header = Redacted.value(upstream.authorization!)
    expect(header.startsWith("Basic ")).toBe(true)
    const [user, token] = atob(header.slice("Basic ".length)).split(":")
    expect(user).toBe("t")
    const claims = decodeClaims(token!)
    expect(claims).toMatchObject({ iss: ORG, repo: "github/octocat/spoon-knife", scopes: ["git:read"] })
    expect(claims.exp - claims.iat).toBe(300)
    // Signing is local: nothing reaches Code Storage, and the token is in no span or log line.
    expect(h.seen).toEqual([])
    expect(h.recorded()).not.toContain(token!)
    expect(String(upstream.authorization)).not.toContain(token!)
  })

  test("escapes each path segment of the repository's name", async () => {
    const h = harness()
    const upstream = await h.run((client) => client.gitRemote("github/o/a b"))
    expect(upstream.url).toBe(`https://${ORG}.code.storage/github/o/a%20b.git`)
  })
})

describe("confirmed safety regressions", () => {
  test.each(["secret\nforged log", "x".repeat(65), "\u001b[31m", "", "UPPER"])(
    "omits unsafe public unknownCode %s",
    (unknownCode) => {
      const error = new CodeStorage.CodeStorageError({
        operation: "readFile",
        code: "bad_request",
        status: 400,
        unknownCode
      })
      expect(error.message).toBe("Code Storage readFile failed: bad_request (400)")
    }
  )
  test("retains bounded identifier diagnostics", () => {
    expect(
      new CodeStorage.CodeStorageError({
        operation: "readFile",
        code: "bad_request",
        status: 400,
        unknownCode: "future_code"
      }).message
    ).toContain("unknown code future_code")
  })
  test.each([501, 505, 506, 507, 508, 510, 511, 600])("does not retry permanent HTTP %i", (status) => {
    expect(
      CodeStorage.isTransient(new CodeStorage.CodeStorageError({ operation: "readFile", code: "http_error", status }))
    ).toBe(false)
  })
  test.each([NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid read cap %s before HTTP with observable failure",
    async (maxBytes) => {
      const h = harness()
      h.faults.push(new Response("abc"))
      const error = await h.fail((client) => client.readFile("r", { path: "x", maxBytes }))
      expect(error.code).toBe("invalid_argument")
      expect(h.seen).toHaveLength(0)
      expect(h.count(CodeStorage.requests, { operation: "readFile", outcome: "invalid_argument" })).toBe(1)
    }
  )
})
