import { Effect, Layer, Option } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { SourceRecord } from "../src/core/SourceRecord.ts"
import { layerMemory, SourceStore } from "../src/core/SourceStore.ts"
import { runSync } from "../src/core/Sync.ts"
import { make as makeClient } from "../src/github/GitHubClient.ts"
import { commentId, issueId, make, PROVIDER } from "../src/github/Sync.ts"
import { type Fixture, json, type Recorded, startFixture } from "./Fixture.ts"
import { runWith, sqlLayer } from "./SourceStoreFixtures.ts"

const OWNER = "example-org"
const REPO = "widgets"
const REPO_ID = 4242
const CONNECTION = "code-host"
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString().replace(".000Z", "Z")
/** A `since` the adapter writes: an ISO instant with milliseconds. */
const since = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString()

interface Issue {
  id: number
  number: number
  title: string
  body: string | null
  user: { id: number; login: string } | null
  html_url: string
  created_at: string
  updated_at: string
  pull_request?: { url: string }
}

interface Comment {
  id: number
  body: string | null
  user: { id: number; login: string } | null
  html_url: string
  issue_url: string
  created_at: string
  updated_at: string
}

/**
 * The slice of GitHub's REST behavior the adapter depends on, served over a
 * real socket: `since` keeps items updated at or after it, `sort=updated`
 * with `direction=asc` orders them, and `page`/`per_page` page them with a
 * `Link: rel="next"` header while more remain.
 */
interface State {
  repository: { id: number; private: boolean }
  issues: Array<Issue>
  comments: Array<Comment>
  /** Rate-limit refusals to serve before answering listings. */
  rateLimited: number
}

const issue = (number: number, second: number, overrides: Partial<Issue> = {}): Issue => ({
  id: 1000 + number,
  number,
  title: `Issue ${number}`,
  body: `Body of ${number}`,
  user: { id: 7, login: "reporter" },
  html_url: `https://github.example.test/${OWNER}/${REPO}/issues/${number}`,
  created_at: at(0),
  updated_at: at(second),
  ...overrides
})

const comment = (id: number, issueNumber: number, second: number, overrides: Partial<Comment> = {}): Comment => ({
  id,
  body: `Comment ${id}`,
  user: { id: 8, login: "reviewer" },
  html_url: `https://github.example.test/${OWNER}/${REPO}/issues/${issueNumber}#issuecomment-${id}`,
  issue_url: `https://api.github.example.test/repos/${OWNER}/${REPO}/issues/${issueNumber}`,
  created_at: at(0),
  updated_at: at(second),
  ...overrides
})

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const listing = <A extends { readonly id: number; readonly updated_at: string }>(
  items: ReadonlyArray<A>,
  url: URL,
  origin: string
): { readonly body: ReadonlyArray<A>; readonly link: string | undefined } => {
  const since = url.searchParams.get("since")
  const perPage = Number(url.searchParams.get("per_page") ?? "30")
  const page = Number(url.searchParams.get("page") ?? "1")
  const selected = items
    .filter((item) => since === null || Date.parse(item.updated_at) >= Date.parse(since))
    .sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at) || left.id - right.id)
  const body = selected.slice((page - 1) * perPage, page * perPage)
  if (page * perPage >= selected.length) return { body, link: undefined }
  const next = new URL(url.toString(), origin)
  next.searchParams.set("page", String(page + 1))
  return { body, link: `<${origin}${next.pathname}${next.search}>; rel="next"` }
}

const serve = async (state: State): Promise<Fixture> => {
  const started = await startFixture((request: Recorded, response) => {
    const origin = `http://${request.headers["host"]}`
    const url = new URL(request.url, origin)
    const base = `/repos/${OWNER}/${REPO}`
    if (url.pathname === base) return json(response, 200, { ...state.repository, full_name: `${OWNER}/${REPO}` })
    if (state.rateLimited > 0) {
      state.rateLimited -= 1
      return json(response, 429, { message: "API rate limit exceeded" }, { "retry-after": "0" })
    }
    const page = url.pathname === `${base}/issues`
      ? listing(state.issues, url, origin)
      : url.pathname === `${base}/issues/comments`
      ? listing(state.comments, url, origin)
      : undefined
    if (page === undefined) return json(response, 404, { message: "Not Found" })
    return json(response, 200, page.body, page.link === undefined ? {} : { link: page.link })
  })
  fixture = started
  return started
}

const adapterFor = (origin: string, options: { perPage?: number; fullListing?: boolean; stream?: string } = {}) =>
  make({
    connectionId: CONNECTION,
    owner: OWNER,
    repo: REPO,
    client: makeClient({ token: "ghp_example_token", apiBaseUrl: origin, maxRetries: 3 }, {}),
    ...options
  })

const everything = [{ connectionId: CONNECTION, containers: ["*"] }]

const byId = (records: ReadonlyArray<SourceRecord>) =>
  Object.fromEntries(records.map((found) => [found.externalId, found]))

const listingRequests = (server: Fixture) =>
  server.requests.map((request) => new URL(request.url, "http://fixture")).filter((url) =>
    url.pathname !== `/repos/${OWNER}/${REPO}`
  )

const contract = (name: string, layer: Layer.Layer<SourceStore>) => {
  const run = runWith(layer)

  describe(name, () => {
    it("syncs issues, pull requests and their comments into records with provenance", async () => {
      const server = await serve({
        repository: { id: REPO_ID, private: true },
        issues: [
          issue(1, 10),
          issue(2, 20, { title: "Add widget", pull_request: { url: "https://api.github.example.test/pulls/2" } }),
          issue(3, 30, { body: null, user: null })
        ],
        comments: [comment(501, 1, 15), comment(502, 2, 25, { body: null })],
        rateLimited: 0
      })
      const [report, records] = await run(Effect.gen(function*() {
        const report = yield* runSync({ adapter: adapterFor(server.origin) })
        return [
          report,
          yield* Effect.flatMap(SourceStore, (store) => store.retrieve({ allowed: everything, limit: 50 }))
        ] as const
      }))
      expect(report).toMatchObject({
        provider: PROVIDER,
        connectionId: CONNECTION,
        stream: `${OWNER}/${REPO}`,
        pages: 2,
        inserted: 5,
        done: true,
        reset: false
      })
      const found = byId(records)
      const repositoryId = String(REPO_ID)
      const first = issueId(REPO_ID, 1)
      expect(found[first]).toMatchObject({
        provider: "github",
        connectionId: CONNECTION,
        kind: "issue",
        url: `https://github.example.test/${OWNER}/${REPO}/issues/1`,
        author: { id: "7", label: "reporter" },
        createdAtMs: Date.parse(at(0)),
        updatedAtMs: Date.parse(at(10)),
        version: null,
        access: { scope: "container", containerId: repositoryId },
        thread: { containerId: repositoryId, threadId: first, parentId: null },
        text: "Issue 1\n\nBody of 1",
        deleted: false
      })
      expect((found[first]!.payload as { number: number }).number).toBe(1)
      expect(found[issueId(REPO_ID, 2)]?.kind).toBe("pull-request")
      expect(found[issueId(REPO_ID, 3)]).toMatchObject({ text: "Issue 3", author: null })
      expect(found[commentId(REPO_ID, 501)]).toMatchObject({
        kind: "issue-comment",
        text: "Comment 501",
        author: { id: "8", label: "reviewer" },
        thread: { containerId: repositoryId, threadId: first, parentId: first }
      })
      expect(found[commentId(REPO_ID, 502)]).toMatchObject({
        text: "",
        thread: { threadId: issueId(REPO_ID, 2), parentId: issueId(REPO_ID, 2) }
      })
      const [issues, comments] = listingRequests(server)
      expect(issues?.pathname).toBe(`/repos/${OWNER}/${REPO}/issues`)
      expect(Object.fromEntries(issues!.searchParams)).toEqual({
        sort: "updated",
        direction: "asc",
        state: "all",
        per_page: "100"
      })
      expect(comments?.pathname).toBe(`/repos/${OWNER}/${REPO}/issues/comments`)
      expect(comments?.searchParams.get("state")).toBeNull()
      expect(server.requests[0]?.headers["authorization"]).toBe("Bearer ghp_example_token")
    })

    it("marks a public repository's records public, still readable only through a grant for that repository", async () => {
      const server = await serve({
        repository: { id: REPO_ID, private: false },
        issues: [issue(1, 10)],
        comments: [],
        rateLimited: 0
      })
      const found = await run(Effect.gen(function*() {
        yield* runSync({ adapter: adapterFor(server.origin) })
        const store = yield* SourceStore
        return {
          granted: yield* store.retrieve({
            allowed: [{ connectionId: CONNECTION, containers: [String(REPO_ID)] }],
            limit: 5
          }),
          otherRepository: yield* store.retrieve({
            allowed: [{ connectionId: CONNECTION, containers: ["99"] }],
            limit: 5
          })
        }
      }))
      expect(found.granted.map((record) => record.access)).toEqual([{ scope: "public", containerId: null }])
      expect(found.otherRepository).toEqual([])
    })

    it("pages by change time, rereading the boundary second, and by page number inside one second", async () => {
      const server = await serve({
        repository: { id: REPO_ID, private: true },
        // Three issues share second 10, more than one page of two holds.
        issues: [issue(1, 10), issue(2, 10), issue(3, 10), issue(4, 40), issue(5, 50)],
        comments: [],
        rateLimited: 0
      })
      const report = await run(runSync({ adapter: adapterFor(server.origin, { perPage: 2 }) }))
      const asked = listingRequests(server).map((url) => [
        url.pathname.endsWith("/comments") ? "comments" : "issues",
        url.searchParams.get("since"),
        url.searchParams.get("page")
      ])
      expect(asked).toEqual([
        ["issues", null, null],
        // Everything since one second before the page's latest change.
        ["issues", since(9), null],
        // A full page inside that second moves on by page number.
        ["issues", since(9), "2"],
        ["issues", since(39), null],
        ["comments", null, null]
      ])
      expect(report).toMatchObject({ pages: 5, inserted: 5, done: true })
    })

    it("pages the comment listing the same way", async () => {
      const server = await serve({
        repository: { id: REPO_ID, private: true },
        issues: [issue(1, 5)],
        comments: [comment(501, 1, 10), comment(502, 1, 20), comment(503, 1, 30)],
        rateLimited: 0
      })
      const report = await run(runSync({ adapter: adapterFor(server.origin, { perPage: 2 }) }))
      const asked = listingRequests(server).map((url) => [
        url.pathname.endsWith("/comments") ? "comments" : "issues",
        url.searchParams.get("since")
      ])
      expect(asked).toEqual([["issues", null], ["comments", null], ["comments", since(19)]])
      expect(report).toMatchObject({ pages: 3, inserted: 4, unchanged: 1, done: true })
    })

    it("resumes incrementally from the committed cursor, picking up edits and new comments", async () => {
      const state: State = {
        repository: { id: REPO_ID, private: true },
        issues: [issue(1, 10), issue(2, 20)],
        comments: [comment(501, 1, 15)],
        rateLimited: 0
      }
      const server = await serve(state)
      const [second, third, stored] = await run(Effect.gen(function*() {
        yield* runSync({ adapter: adapterFor(server.origin) })
        state.issues[0] = issue(1, 60, { body: "Edited body" })
        state.comments.push(comment(502, 2, 70))
        const second = yield* runSync({ adapter: adapterFor(server.origin) })
        const third = yield* runSync({ adapter: adapterFor(server.origin) })
        return [
          second,
          third,
          yield* Effect.flatMap(SourceStore, (store) => store.get(CONNECTION, issueId(REPO_ID, 1)))
        ] as const
      }))
      const asked = listingRequests(server).slice(2).map((url) => url.searchParams.get("since"))
      expect(asked).toEqual([since(19), since(14), since(59), since(69)])
      // Issue 2 and comment 501 are reread from the overlap second and left alone.
      expect(second).toMatchObject({ inserted: 1, updated: 1, unchanged: 2, done: true })
      // Nothing changed: the overlap is reread, nothing is written, the cursor holds.
      expect(third).toMatchObject({ inserted: 0, updated: 0, unchanged: 2, done: true })
      expect(Option.getOrThrow(stored).record.text).toBe("Issue 1\n\nEdited body")
    })

    it("retries a rate-limited listing through the client and completes the sync", async () => {
      const server = await serve({
        repository: { id: REPO_ID, private: true },
        issues: [issue(1, 10)],
        comments: [],
        rateLimited: 2
      })
      const report = await run(runSync({ adapter: adapterFor(server.origin) }))
      expect(report).toMatchObject({ inserted: 1, done: true })
      const issueRequests = listingRequests(server).filter((url) => url.pathname.endsWith("/issues"))
      expect(issueRequests).toHaveLength(3)
    })

    it("finds deletions only through a full listing, which sweeps what it no longer lists", async () => {
      const state: State = {
        repository: { id: REPO_ID, private: true },
        issues: [issue(1, 10), issue(2, 20)],
        comments: [comment(501, 1, 15), comment(502, 2, 25)],
        rateLimited: 0
      }
      const server = await serve(state)
      const result = await run(Effect.gen(function*() {
        const store = yield* SourceStore
        yield* runSync({ adapter: adapterFor(server.origin) })
        state.issues.splice(1, 1)
        state.comments.splice(1, 1)
        const incremental = yield* runSync({ adapter: adapterFor(server.origin) })
        const stillVisible = (yield* store.retrieve({ allowed: everything, limit: 10 })).length
        const full = yield* runSync({ adapter: adapterFor(server.origin, { fullListing: true }) })
        const afterFull = byId(yield* store.retrieve({ allowed: everything, limit: 10 }))
        const deleted = yield* store.get(CONNECTION, issueId(REPO_ID, 2))
        return { incremental, stillVisible, full, afterFull, deleted }
      }))
      expect(result.incremental.swept).toBe(0)
      expect(result.stillVisible).toBe(4)
      expect(result.full).toMatchObject({ reset: true, swept: 2, done: true })
      expect(Object.keys(result.afterFull).sort()).toEqual([commentId(REPO_ID, 501), issueId(REPO_ID, 1)].sort())
      expect(Option.getOrThrow(result.deleted).record).toMatchObject({ deleted: true, text: "", payload: null })
      // The full walk lists from the beginning.
      const fullWalk = listingRequests(server).slice(4)
      expect(fullWalk.map((url) => url.searchParams.get("since"))).toEqual([null, null])
    })

    it("continues a full listing across runs without restarting it", async () => {
      const server = await serve({
        repository: { id: REPO_ID, private: true },
        issues: [issue(1, 10), issue(2, 20)],
        comments: [comment(501, 1, 15)],
        rateLimited: 0
      })
      const [first, second] = await run(Effect.gen(function*() {
        const adapter = adapterFor(server.origin, { fullListing: true })
        return [yield* runSync({ adapter, maxPages: 1 }), yield* runSync({ adapter })] as const
      }))
      expect(first).toMatchObject({ pages: 1, reset: true, done: false })
      expect(second).toMatchObject({ pages: 1, reset: false, done: true })
      expect(listingRequests(server).map((url) => url.pathname.endsWith("/comments"))).toEqual([false, true])
    })

    it("moves on by page number past an empty page that still links onward", async () => {
      let served = 0
      fixture = await startFixture((request, response) => {
        const url = new URL(request.url, "http://fixture")
        if (url.pathname === `/repos/${OWNER}/${REPO}`) return json(response, 200, { id: REPO_ID, private: true })
        served += 1
        if (url.pathname.endsWith("/issues") && url.searchParams.get("page") === null) {
          return json(response, 200, [], {
            link: `<http://${request.headers["host"]}${url.pathname}?page=2>; rel="next"`
          })
        }
        return json(response, 200, [])
      })
      const server = fixture
      const report = await run(runSync({ adapter: adapterFor(server.origin) }))
      expect(report).toMatchObject({ pages: 3, inserted: 0, done: true })
      expect(listingRequests(server).map((url) => url.searchParams.get("page"))).toEqual([null, "2", null])
      expect(served).toBe(3)
    })

    it("refuses a stored cursor it did not write instead of restarting the listing", async () => {
      const server = await serve({
        repository: { id: REPO_ID, private: true },
        issues: [],
        comments: [],
        rateLimited: 0
      })
      const adapter = adapterFor(server.origin)
      const failures = await Effect.runPromise(Effect.forEach(
        [
          "{not json",
          JSON.stringify({ v: 2 }),
          JSON.stringify({
            v: 1,
            phase: "issues",
            full: false,
            issues: { since: "yesterday", page: 1 },
            comments: { since: null, page: 1 }
          })
        ],
        (cursor) => Effect.flip(adapter.changes(cursor))
      ))
      expect(failures.map((failure) => failure.reason)).toEqual(["invalid-config", "invalid-config", "invalid-config"])
      expect(server.requests).toHaveLength(0)
    })

    it("fails decode-failed on items it cannot read", async () => {
      const cases: ReadonlyArray<Pick<State, "issues" | "comments">> = [
        { issues: [{ ...issue(1, 10), title: undefined as unknown as string }], comments: [] },
        { issues: [issue(1, 10, { updated_at: "later" })], comments: [] },
        { issues: [issue(1, 10, { created_at: "earlier" })], comments: [] },
        { issues: [], comments: [comment(501, 1, 15, { issue_url: "https://api.github.example.test/elsewhere" })] }
      ]
      const reasons: Array<string> = []
      for (const items of cases) {
        const server = await serve({ repository: { id: REPO_ID, private: true }, ...items, rateLimited: 0 })
        reasons.push((await run(Effect.flip(runSync({ adapter: adapterFor(server.origin) })))).reason)
        await server.close()
        fixture = undefined
      }
      expect(reasons).toEqual(["decode-failed", "decode-failed", "decode-failed", "decode-failed"])
    })
  })
}

contract("GitHub sync (memory store)", layerMemory)
contract("GitHub sync (SQLite store)", sqlLayer as unknown as Layer.Layer<SourceStore>)

describe("GitHub sync adapter configuration", () => {
  const client = makeClient({ token: "ghp_example_token", apiBaseUrl: "http://127.0.0.1:9" }, {})

  it("refuses an owner or repository name GitHub could not have issued, and a page size out of range", () => {
    expect(() => make({ connectionId: CONNECTION, owner: "..", repo: REPO, client })).toThrow(/not a valid name/)
    expect(() => make({ connectionId: CONNECTION, owner: OWNER, repo: "..", client })).toThrow(/not a valid name/)
    for (const perPage of [0, 101, 2.5]) {
      expect(() => make({ connectionId: CONNECTION, owner: OWNER, repo: REPO, client, perPage })).toThrow(
        /perPage must be an integer between 1 and 100/
      )
    }
  })

  it("names its stream after the repository unless told otherwise", () => {
    expect(make({ connectionId: CONNECTION, owner: OWNER, repo: REPO, client })).toMatchObject({
      provider: "github",
      connectionId: CONNECTION,
      stream: `${OWNER}/${REPO}`
    })
    expect(make({ connectionId: CONNECTION, owner: OWNER, repo: REPO, client, stream: "repo-4242" }).stream).toBe(
      "repo-4242"
    )
  })
})
