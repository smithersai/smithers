/**
 * `GitHub.GitDatabase` against a local server that answers as GitHub's Git
 * database API and GraphQL did when probed on 2026-11-10: content-addressed
 * writes that repeat idempotently, `updateRefs` applied atomically only when
 * every `beforeOid` holds and refused otherwise with a generic error, and an
 * unknown object refused `UNPROCESSABLE`. The server keeps its objects in
 * `@smthrs/jj`'s memory repository, whose ids `test/Repository.test.ts` pins
 * to ids GitHub answered. A real-GitHub replay lives in `apps/vibelang`.
 */
import * as Repository from "@smthrs/jj/Repository"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import * as GitDatabase from "../src/github/GitDatabase.ts"
import type { GitHubClient } from "../src/github/GitHubClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"
import { gitHubLayer } from "./Http.ts"

type Raw = Record<string, any>

interface FakeGitHub {
  readonly fixture: Fixture
  readonly store: Repository.Repository
  /** The next write applies, then answers 502. */
  lose: boolean
  /** The next request whose path matches answers this status and body instead. */
  canned: Array<{ readonly match: RegExp; readonly status: number; readonly body: unknown }>
  readonly paths: () => ReadonlyArray<string>
}

let github: FakeGitHub | undefined

afterEach(async () => {
  await github?.fixture.close()
  github = undefined
})

const seconds = (date: string) => Date.parse(date) / 1000
const exec = <A>(effect: Effect.Effect<A, Repository.RepositoryError>) => Effect.runPromise(Effect.result(effect))

const startGitHub = async (): Promise<FakeGitHub> => {
  const store = Repository.makeMemory()
  const state = { lose: false, canned: [] as FakeGitHub["canned"] }
  const fixture = await startFixture(async (request, response) => {
    const path = new URL(request.url, "http://github.test").pathname
    const body: Raw = request.body.length > 0 ? JSON.parse(request.body) : {}
    const key = path === "/graphql" ? `graphql ${body.query}` : `${request.method} ${path}`
    const canned = state.canned.findIndex((answer) => answer.match.test(key))
    if (canned >= 0) {
      const [answer] = state.canned.splice(canned, 1)
      return json(response, answer!.status, answer!.body)
    }
    const answer = (status: number, value: unknown) => {
      if (request.method === "POST" && state.lose && !(path === "/graphql" && !/mutation/.test(body.query))) {
        state.lose = false
        return json(response, 502, { message: "Bad Gateway" })
      }
      return json(response, status, value)
    }
    const result = <A>(effect: Effect.Effect<A, Repository.RepositoryError>) => exec(effect)
    let match: RegExpExecArray | null
    if (request.method === "POST" && path === "/repos/o/r/git/blobs") {
      const written = await result(store.writeBlob(body.content))
      return answer(201, { sha: written._tag === "Success" ? written.success : "" })
    }
    if ((match = /^\/repos\/o\/r\/git\/blobs\/(\w+)$/.exec(path)) !== null) {
      const read = await result(store.readBlob(match[1]!))
      return read._tag === "Success"
        ? json(response, 200, {
          content: btoa(String.fromCharCode(...new TextEncoder().encode(read.success))).replace(/(.{60})/g, "$1\n"),
          encoding: "base64"
        })
        : json(response, 404, { message: "Not Found" })
    }
    if (request.method === "POST" && path === "/repos/o/r/git/trees") {
      const entries = (body.tree as Array<Raw>).map((entry) => ({ name: entry.path, mode: entry.mode, oid: entry.sha }))
      const written = await result(store.writeTree(entries))
      return written._tag === "Success"
        ? answer(201, { sha: written.success })
        : json(response, 422, { message: "Invalid tree info" })
    }
    if ((match = /^\/repos\/o\/r\/git\/trees\/(\w+)$/.exec(path)) !== null) {
      const read = await result(store.readTree(match[1]!))
      return read._tag === "Success"
        ? json(response, 200, {
          sha: match[1],
          truncated: false,
          tree: read.success.map((entry) => ({ path: entry.name, mode: entry.mode, type: "blob", sha: entry.oid }))
        })
        : json(response, 404, { message: "Not Found" })
    }
    if (request.method === "POST" && path === "/repos/o/r/git/commits") {
      const who = (raw: Raw) => ({ name: raw.name, email: raw.email, seconds: seconds(raw.date) })
      const written = await result(
        store.writeCommit({
          tree: body.tree,
          parents: body.parents,
          author: who(body.author),
          committer: who(body.committer),
          message: body.message
        })
      )
      return written._tag === "Success"
        ? answer(201, { sha: written.success })
        : json(response, 422, { message: "Tree SHA does not exist" })
    }
    if ((match = /^\/repos\/o\/r\/git\/commits\/(\w+)$/.exec(path)) !== null) {
      const read = await result(store.readCommit(match[1]!))
      return read._tag === "Success"
        ? json(response, 200, {
          sha: read.success.oid,
          message: read.success.message,
          tree: { sha: read.success.tree },
          parents: read.success.parents.map((sha) => ({ sha }))
        })
        : json(response, 404, { message: "Not Found" })
    }
    if (path === "/graphql") {
      const query = body.query as string
      const variables = body.variables as Raw
      if (query.includes("object(expression")) {
        const read = await result(store.readCommit(variables.expression))
        if (read._tag === "Success") {
          return json(response, 200, {
            data: { repository: { object: { __typename: "Commit", oid: read.success.oid } } }
          })
        }
        const blob = await result(store.readBlob(variables.expression.padEnd(40, "0")))
        return json(response, 200, {
          data: {
            repository: { object: blob._tag === "Success" ? { __typename: "Blob", oid: variables.expression } : null }
          }
        })
      }
      if (query.includes("ref(qualifiedName")) {
        const names = Object.keys(variables).filter((name) => /^r\d+$/.test(name))
        const read = await result(store.readRefs(names.map((name) => variables[name])))
        const refs = read._tag === "Success" ? read.success : []
        return json(response, 200, {
          data: {
            repository: Object.fromEntries(
              names.map((name, i) => [name, refs[i]!.oid === null ? null : { target: { oid: refs[i]!.oid } }])
            )
          }
        })
      }
      if (query.includes("updateRefs")) {
        const input = variables.input as Raw
        expect(input.repositoryId).toBe("R_kgDOtest")
        expect((input.refUpdates as Array<Raw>).every((update) => update.force === true)).toBe(true)
        const zero = (oid: string) => oid === "0".repeat(40) ? null : oid
        const moved = await result(store.updateRefs({
          operation: input.clientMutationId,
          updates: (input.refUpdates as Array<Raw>).map((update) => ({
            ref: update.name,
            before: zero(update.beforeOid),
            after: zero(update.afterOid)
          }))
        }))
        if (moved._tag === "Success") {
          return answer(200, { data: { updateRefs: { clientMutationId: input.clientMutationId } } })
        }
        return moved.failure.code === "conflict"
          ? json(response, 200, { errors: [{ message: "Something went wrong while executing your query." }] })
          : json(response, 200, {
            data: { updateRefs: null },
            errors: [{ type: "UNPROCESSABLE", message: "twirp error not_found: missing" }]
          })
      }
      if (query.includes("{ id }")) return json(response, 200, { data: { repository: { id: "R_kgDOtest" } } })
    }
    json(response, 404, { message: "Not Found" })
  })
  github = Object.assign(state, {
    fixture,
    store,
    paths: () =>
      fixture.requests.map((request) => {
        const body = request.body.length > 0 ? JSON.parse(request.body) : {}
        const path = new URL(request.url, "http://github.test").pathname
        return path === "/graphql"
          ? `graphql ${/updateRefs\(|object\(|ref\(|\{ id \}/.exec(body.query)![0]}`
          : `${request.method} ${path}`
      })
  })
  return github
}

const layer = () => gitHubLayer({ token: "token-for-tests", apiBaseUrl: github!.fixture.origin }, {})
const repository = () => Effect.runPromise(GitDatabase.make("o", "r").pipe(Effect.provide(layer())))
const run = <A>(effect: Effect.Effect<A, Repository.RepositoryError>) => Effect.runPromise(effect)
const failure = <A>(effect: Effect.Effect<A, Repository.RepositoryError>) => Effect.runPromise(Effect.flip(effect))

const who: Repository.Person = { name: "VibeLang history", email: "history@vibelang.invalid", seconds: 1794009600 }
const MYTHICAL = "refs/heads/mythical"
const NOTES = "refs/notes/mythical"

/** A commit over a one-file tree, written through the adapter. */
const commitOn = async (repo: Repository.Repository, text: string, parents: ReadonlyArray<string> = []) => {
  const blob = await run(repo.writeBlob(text))
  const tree = await run(repo.writeTree([{ name: "a.txt", mode: "100644", oid: blob }]))
  return run(repo.writeCommit({ tree, parents, author: who, committer: who, message: `${text}\n` }))
}

describe("GitDatabase objects", () => {
  it("writes blobs, trees and commits under git's ids and reads them back", async () => {
    await startGitHub()
    const repo = await repository()
    const text = "Notes ✓ — 100 %\n".repeat(8)
    const blob = await run(repo.writeBlob(text))
    expect(blob).toBe(await run(Repository.hashBlob(text)))
    expect(await run(repo.readBlob(blob))).toBe(text)
    const tree = await run(repo.writeTree([{ name: "a.txt", mode: "100644", oid: blob }]))
    expect(await run(repo.readTree(tree))).toEqual([{ name: "a.txt", mode: "100644", oid: blob }])
    expect(await run(repo.writeTree([]))).toBe(Repository.EMPTY_TREE)
    const message = "m1 first\n\nMythical: m1\n"
    const oid = await run(repo.writeCommit({ tree, parents: [], author: who, committer: who, message }))
    expect(await run(repo.readCommit(oid))).toEqual({ oid, tree, parents: [], message })
    expect((await run(repo.readCommit(oid.slice(0, 12)))).oid).toBe(oid)
    expect(github!.paths()).toEqual([
      "POST /repos/o/r/git/blobs",
      `GET /repos/o/r/git/blobs/${blob}`,
      "POST /repos/o/r/git/trees",
      `GET /repos/o/r/git/trees/${tree}`,
      "POST /repos/o/r/git/commits",
      `GET /repos/o/r/git/commits/${oid}`,
      "graphql object(",
      `GET /repos/o/r/git/commits/${oid}`
    ])
  })

  it("answers a submodule and a tree entry with their types, and a blob GitHub sends as text", async () => {
    await startGitHub()
    const repo = await repository()
    const blob = await run(repo.writeBlob("x"))
    const inner = await run(repo.writeTree([{ name: "x", mode: "100755", oid: blob }]))
    github!.canned.push({
      match: /POST \/repos\/o\/r\/git\/trees/,
      status: 201,
      body: {
        sha: await run(
          Repository.hashTree([{ name: "d", mode: "040000", oid: inner }, { name: "m", mode: "160000", oid: blob }])
        )
      }
    })
    await run(repo.writeTree([{ name: "d", mode: "040000", oid: inner }, { name: "m", mode: "160000", oid: blob }]))
    const sent = JSON.parse(github!.fixture.requests.at(-1)!.body).tree.map((entry: Raw) => entry.type)
    expect(sent).toEqual(["tree", "commit"])
    github!.canned.push({
      match: /GET \/repos\/o\/r\/git\/blobs/,
      status: 200,
      body: { content: "plain", encoding: "utf-8" }
    })
    expect(await run(repo.readBlob(blob))).toBe("plain")
  })

  it("refuses an answer for another object, and maps GitHub's statuses onto codes", async () => {
    await startGitHub()
    const repo = await repository()
    github!.canned.push({ match: /POST \/repos\/o\/r\/git\/blobs/, status: 201, body: { sha: "f".repeat(40) } })
    expect((await failure(repo.writeBlob("x"))).code).toBe("invalid")
    expect((await failure(repo.readBlob("e".repeat(40)))).code).toBe("not_found")
    const blob = await run(repo.writeBlob("x"))
    expect((await failure(repo.writeTree([{ name: "a", mode: "040000", oid: blob }]))).code).toBe("invalid")
    expect(
      (await failure(repo.writeCommit({ tree: blob, parents: [], author: who, committer: who, message: "" }))).code
    )
      .toBe("invalid")
    github!.canned.push({ match: /GET \/repos\/o\/r\/git\/trees/, status: 500, body: { message: "boom" } })
    expect((await failure(repo.readTree(blob))).code).toBe("unavailable")
    github!.canned.push({
      match: /GET \/repos\/o\/r\/git\/trees/,
      status: 200,
      body: { sha: blob, truncated: true, tree: [] }
    })
    expect((await failure(repo.readTree(blob))).message).toContain("truncated")
    github!.canned.push({
      match: /GET \/repos\/o\/r\/git\/trees/,
      status: 200,
      body: { sha: blob, truncated: false, tree: [{ path: "a", mode: "100600", sha: blob }] }
    })
    expect((await failure(repo.readTree(blob))).message).toContain("unknown mode")
  })

  it("validates input before any request", async () => {
    await startGitHub()
    const repo = await repository()
    const codes = await Promise.all([
      repo.readBlob("x"),
      repo.writeBlob(7 as never),
      repo.readTree("x"),
      repo.writeTree([{ name: "a/b", mode: "100644", oid: "e".repeat(40) }]),
      repo.readCommit("xyz"),
      repo.writeCommit({ tree: "x", parents: [], author: who, committer: who, message: "" }),
      repo.readRefs(["heads/x"]),
      repo.updateRefs({ operation: "", updates: [] })
    ].map(async (effect) => (await failure(effect as Effect.Effect<unknown, Repository.RepositoryError>)).code))
    expect(codes).toEqual(Array(8).fill("invalid"))
    expect(github!.fixture.requests).toEqual([])
    const refused = await Effect.runPromise(
      Effect.flip(GitDatabase.make("o/x", "r").pipe(Effect.provide(layer())))
    ) as IntegrationError
    expect(refused.reason).toBe("invalid-config")
  })

  it("answers not_found for a prefix that names no commit, or names another object", async () => {
    await startGitHub()
    const repo = await repository()
    expect((await failure(repo.readCommit("abcdef"))).code).toBe("not_found")
    const blob = await run(repo.writeBlob("x"))
    github!.canned.push({
      match: /object\(expression/,
      status: 200,
      body: { data: { repository: { object: { __typename: "Blob", oid: blob } } } }
    })
    expect((await failure(repo.readCommit(blob.slice(0, 8)))).code).toBe("not_found")
    github!.canned.push({ match: /object\(expression/, status: 200, body: { data: null } })
    expect((await failure(repo.readCommit("abcdef"))).code).toBe("not_found")
  })
})

describe("GitDatabase refs", () => {
  it("moves several refs in one atomic updateRefs, reading the repository's id once", async () => {
    await startGitHub()
    const repo = await repository()
    const a = await commitOn(repo, "a")
    const b = await commitOn(repo, "b", [a])
    expect((await run(repo.readCommit(b))).parents).toEqual([a])
    await run(repo.updateRefs({
      operation: "export/1",
      updates: [
        { ref: MYTHICAL, before: null, after: a },
        { ref: NOTES, before: null, after: a }
      ]
    }))
    // A rewrite that is not a fast-forward moves too: the old value is the fence.
    await run(repo.updateRefs({
      operation: "export/2",
      updates: [
        { ref: MYTHICAL, before: a, after: b },
        { ref: NOTES, before: a, after: a }
      ]
    }))
    expect(await run(repo.readRefs([MYTHICAL, NOTES, "refs/heads/none"]))).toEqual([
      { ref: MYTHICAL, oid: b },
      { ref: NOTES, oid: a },
      { ref: "refs/heads/none", oid: null }
    ])
    expect(github!.paths().filter((path) => path.startsWith("graphql"))).toEqual([
      "graphql { id }",
      "graphql updateRefs(",
      "graphql updateRefs(",
      "graphql ref("
    ])
    await run(repo.updateRefs({ operation: "drop", updates: [{ ref: NOTES, before: a, after: null }] }))
    expect(await run(repo.readRefs([NOTES]))).toEqual([{ ref: NOTES, oid: null }])
  })

  it("names the refs that moved when GitHub refuses a stale old value, and moves none", async () => {
    await startGitHub()
    const repo = await repository()
    const a = await commitOn(repo, "a")
    const b = await commitOn(repo, "b", [a])
    await run(
      repo.updateRefs({
        operation: "x",
        updates: [{ ref: MYTHICAL, before: null, after: a }, { ref: NOTES, before: null, after: a }]
      })
    )
    const conflict = await failure(repo.updateRefs({
      operation: "y",
      updates: [
        { ref: MYTHICAL, before: a, after: b },
        { ref: NOTES, before: b, after: b }
      ]
    }))
    expect([conflict.code, conflict.refs]).toEqual(["conflict", [NOTES]])
    expect(await run(repo.readRefs([MYTHICAL]))).toEqual([{ ref: MYTHICAL, oid: a }])
  })

  it("reads a lost answer back: landed is success, untouched is unavailable", async () => {
    await startGitHub()
    const repo = await repository()
    const a = await commitOn(repo, "a")
    github!.lose = true
    await run(repo.updateRefs({ operation: "x", updates: [{ ref: MYTHICAL, before: null, after: a }] }))
    expect(await run(repo.readRefs([MYTHICAL]))).toEqual([{ ref: MYTHICAL, oid: a }])
    github!.canned.push({ match: /updateRefs/, status: 502, body: { message: "Bad Gateway" } })
    const lost = await failure(
      repo.updateRefs({ operation: "y", updates: [{ ref: MYTHICAL, before: a, after: null }] })
    )
    expect([lost.code, lost.message]).toEqual([
      "unavailable",
      "unavailable: Repository.updateRefs: GitHub refused or lost the update; no ref moved"
    ])
    github!.canned.push({ match: /updateRefs/, status: 200, body: { data: { updateRefs: null } } })
    expect(
      (await failure(repo.updateRefs({ operation: "z", updates: [{ ref: MYTHICAL, before: a, after: null }] }))).code
    )
      .toBe("unavailable")
    expect(
      (await failure(
        repo.updateRefs({ operation: "w", updates: [{ ref: NOTES, before: null, after: "e".repeat(40) }] })
      )).code
    )
      .toBe("unavailable")
  })

  it("fails unsupported when GitHub has no updateRefs mutation", async () => {
    await startGitHub()
    const repo = await repository()
    github!.canned.push({
      match: /updateRefs/,
      status: 200,
      body: { errors: [{ message: "Field 'updateRefs' doesn't exist on type 'Mutation'" }] }
    })
    const refused = await failure(
      repo.updateRefs({ operation: "x", updates: [{ ref: MYTHICAL, before: null, after: null }] })
    )
    expect(refused.code).toBe("unsupported")
  })

  it("fails unavailable when GitHub answers no repository", async () => {
    await startGitHub()
    const repo = await repository()
    github!.canned.push({ match: /ref\(qualifiedName/, status: 200, body: { data: { repository: null } } })
    expect((await failure(repo.readRefs([MYTHICAL]))).code).toBe("unavailable")
    github!.canned.push({ match: /\{ id \}/, status: 200, body: { data: { repository: null } } })
    expect(
      (await failure(repo.updateRefs({ operation: "x", updates: [{ ref: MYTHICAL, before: null, after: null }] }))).code
    )
      .toBe("unavailable")
    github!.canned.push({ match: /ref\(qualifiedName/, status: 200, body: {} })
    expect((await failure(repo.readRefs([MYTHICAL]))).code).toBe("unavailable")
  })

  it("serves as a layer", async () => {
    await startGitHub()
    const program = Effect.gen(function*() {
      const repo = yield* Repository.Repository
      return yield* repo.readRefs([MYTHICAL])
    })
    const refs = await Effect.runPromise(
      program.pipe(Effect.provide(GitDatabase.layer("o", "r")), Effect.provide(layer())) as Effect.Effect<
        ReadonlyArray<Repository.RefValue>,
        Repository.RepositoryError | IntegrationError,
        never
      >
    )
    expect(refs).toEqual([{ ref: MYTHICAL, oid: null }])
  })
})

export type { GitHubClient }
