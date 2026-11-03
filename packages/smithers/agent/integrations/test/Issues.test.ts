/**
 * Issue and issue-comment operations against a stateful fake GitHub on a real
 * socket.
 *
 * Writes change the fake's state, so the recovery cases assert on what the
 * repository ends up holding: a POST GitHub applied but whose answer was lost
 * is found by its write marker and adopted, and one GitHub never received is
 * written exactly once more. The label writes are idempotent, so a lost answer
 * is retryable and the repeat changes nothing twice.
 */
import { Effect, Option } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import { RECONCILE_PAGES } from "../src/github/Actions.ts"
import type { GitHubClient } from "../src/github/GitHubClient.ts"
import * as Issues from "../src/github/Issues.vibe"
import { type Fixture, json, startFixture } from "./Fixture.ts"
import { faultingTransport, gitHubLayer, gitHubLayerOver } from "./Http.ts"

type Raw = Record<string, unknown>

interface FakeGitHub {
  readonly fixture: Fixture
  readonly issues: Array<Raw>
  /** The repository's labels. */
  readonly labels: Array<Raw>
  readonly comments: Map<number, Array<Raw>>
  /** Items each listing page holds at most, below the client's `per_page`. */
  pageSize: number
  /** Raw items every listing starts with: things GitHub's schema does not promise. */
  junk: Array<unknown>
  /** The next write applies, then answers 502. */
  lose: boolean
  readonly writes: () => ReadonlyArray<string>
}

let github: FakeGitHub | undefined

afterEach(async () => {
  await github?.fixture.close()
  github = undefined
})

const USER = { id: 1, login: "octocat", type: "User", site_admin: false }

let clock = Date.parse("2026-10-20T10:00:00Z")
const stamp = () => new Date(clock += 1000).toISOString()

let labelId = 100
const rawLabel = (name: string, extra: Raw = {}): Raw => {
  labelId += 1
  return {
    id: labelId,
    node_id: `LA_${labelId}`,
    url: `https://api.github.test/repos/o/r/labels/${encodeURIComponent(name)}`,
    name,
    color: "ededed",
    default: false,
    description: null,
    ...extra
  }
}

const sameName = (name: string) => (label: Raw) => (label["name"] as string).toLowerCase() === name.toLowerCase()

const rawIssue = (number: number, body: string | null, extra: Raw = {}): Raw => {
  const at = stamp()
  return {
    id: 1000 + number,
    node_id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    body,
    state: "open",
    state_reason: null,
    user: USER,
    labels: [rawLabel("bug", { color: "d73a4a", default: true, description: "Something isn't working" })],
    comments: 0,
    created_at: at,
    updated_at: at,
    closed_at: null,
    html_url: `https://github.test/o/r/issues/${number}`,
    ...extra
  }
}

const rawComment = (id: number, issue: number, body: string | null): Raw => {
  const at = stamp()
  return {
    id,
    node_id: `IC_${id}`,
    body,
    user: USER,
    created_at: at,
    updated_at: at,
    issue_url: `https://api.github.test/repos/o/r/issues/${issue}`,
    html_url: `https://github.test/o/r/issues/${issue}#issuecomment-${id}`,
    author_association: "OWNER"
  }
}

const startGitHub = async (): Promise<FakeGitHub> => {
  let nextId = 5000
  const state = {
    issues: [] as Array<Raw>,
    labels: [] as Array<Raw>,
    comments: new Map<number, Array<Raw>>(),
    pageSize: 100,
    junk: [],
    lose: false
  }
  const write = (response: Parameters<typeof json>[0], status: number, body: unknown) => {
    if (state.lose) {
      state.lose = false
      return json(response, 502, { message: "Bad Gateway" })
    }
    json(response, status, body)
  }
  const listing = (url: URL, origin: string, items: ReadonlyArray<unknown>) => {
    const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 30), state.pageSize)
    const page = Number(url.searchParams.get("page") ?? 1)
    const all = [...state.junk, ...items]
    const slice = all.slice((page - 1) * perPage, page * perPage)
    const next = new URL(url.pathname + url.search, origin)
    next.searchParams.set("page", String(page + 1))
    return { slice, headers: page * perPage < all.length ? { link: `<${next}>; rel="next"` } : {} }
  }
  const since = (url: URL) => {
    const value = url.searchParams.get("since")
    return (item: Raw) => value === null || Date.parse(item["updated_at"] as string) >= Date.parse(value)
  }
  const fixture: Fixture = await startFixture((request, response) => {
    const url = new URL(request.url, "http://github.test")
    const path = url.pathname
    const body = request.body.length > 0 ? JSON.parse(request.body) : undefined
    if (path === "/repos/o/r/issues") {
      if (request.method === "POST") {
        const number = state.issues.length + 1
        const issue = rawIssue(number, body.body)
        issue["title"] = body.title
        state.issues.push(issue)
        return write(response, 201, issue)
      }
      const newestFirst = [...state.issues].filter(since(url)).sort((a, b) =>
        Date.parse(b["created_at"] as string) - Date.parse(a["created_at"] as string)
      )
      const { headers, slice } = listing(url, fixture.origin, newestFirst)
      return json(response, 200, slice, headers)
    }
    const commentsOf = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path)
    if (commentsOf !== null) {
      const number = Number(commentsOf[1])
      const thread = state.comments.get(number) ?? []
      if (request.method === "POST") {
        const comment = rawComment(nextId++, number, body.body)
        state.comments.set(number, [...thread, comment])
        return write(response, 201, comment)
      }
      const { headers, slice } = listing(url, fixture.origin, thread.filter(since(url)))
      return json(response, 200, slice, headers)
    }
    const labelsOf = /^\/repos\/o\/r\/issues\/(\d+)\/labels(?:\/([^/]+))?$/.exec(path)
    if (labelsOf !== null) {
      const target = state.issues.find((candidate) => candidate["number"] === Number(labelsOf[1]))
      if (target === undefined) return json(response, 404, { message: "Not Found" })
      const held = target["labels"] as Array<Raw>
      if (request.method === "POST") {
        // GitHub adds what the issue lacks, compared without case, and creates a missing label.
        for (const name of body.labels as Array<string>) if (!held.some(sameName(name))) held.push(rawLabel(name))
        return write(response, 200, held)
      }
      const index = held.findIndex(sameName(decodeURIComponent(labelsOf[2]!)))
      if (index < 0) return json(response, 404, { message: "Label does not exist" })
      held.splice(index, 1)
      return write(response, 200, held)
    }
    if (path === "/repos/o/r/labels" && request.method === "POST") {
      if (state.labels.some(sameName(body.name))) {
        return json(response, 422, {
          message: "Validation Failed",
          errors: [{ resource: "Label", code: "already_exists", field: "name" }]
        })
      }
      const label = rawLabel(body.name, { color: body.color, description: body.description ?? null })
      state.labels.push(label)
      return write(response, 201, label)
    }
    const one = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(path)
    const issue = one === null ? undefined : state.issues.find((candidate) => candidate["number"] === Number(one[1]))
    if (issue !== undefined) return json(response, 200, issue)
    json(response, 404, { message: "Not Found" })
  })
  return Object.assign(state, {
    fixture,
    writes: () =>
      fixture.requests.filter((request) => request.method !== "GET").map((request) =>
        `${request.method} ${new URL(request.url, "http://github.test").pathname}`
      )
  }) as FakeGitHub
}

const layer = () => gitHubLayer({ token: "t", apiBaseUrl: (github as FakeGitHub).fixture.origin }, {})

const run = <A>(effect: Effect.Effect<A, IntegrationError, GitHubClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer())))

const failure = <A>(effect: Effect.Effect<A, IntegrationError, GitHubClient>): Promise<IntegrationError> =>
  Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(layer())))

const query = (index: number) => new URL((github as FakeGitHub).fixture.requests[index]!.url, "http://x").searchParams

const SINCE = "2026-10-20T00:00:00Z"

describe("the write marker", () => {
  it("is a hidden HTML comment naming the write id", () => {
    expect(Issues.writeMarker("0b6f-uuid-1")).toBe("<!-- smithers:write=0b6f-uuid-1 -->")
    expect(Issues.writeMarker("x".repeat(100))).toBe(`<!-- smithers:write=${"x".repeat(100)} -->`)
  })

  it.each([
    ["an empty id", ""],
    ["a space", "a b"],
    ["101 characters", "x".repeat(101)],
    ["a comment terminator", "a-->b"],
    ["an underscore", "a_b"]
  ])("refuses %s with invalid-config", (_name, writeId) => {
    let thrown: any
    try {
      Issues.writeMarker(writeId)
    } catch (error) {
      thrown = error
    }
    expect(thrown?.reason).toBe("invalid-config")
    expect(thrown?.details?.writeId).toBe(writeId.slice(0, 100))
  })

  it("refuses a write id that is not a string, naming only its type", () => {
    expect(() => Issues.writeMarker(7 as unknown as string)).toThrow(/write id/)
    try {
      Issues.withWriteMarker("body", undefined as unknown as string)
    } catch (error) {
      expect((error as IntegrationError).details?.["writeId"]).toBe("undefined")
    }
    expect.assertions(2)
  })

  it("follows the body after a blank line, or stands alone on an empty body", () => {
    expect(Issues.withWriteMarker("Hello", "w-1")).toBe("Hello\n\n<!-- smithers:write=w-1 -->")
    expect(Issues.withWriteMarker("", "w-1")).toBe("<!-- smithers:write=w-1 -->")
  })

  it.each<[string, string | null | undefined, string | undefined]>([
    ["null", null, undefined],
    ["undefined", undefined, undefined],
    ["an empty body", "", undefined],
    ["a body without a marker", "Plain text <!-- a comment -->", undefined],
    ["a marked body", "Hello\n\n<!-- smithers:write=w-1 -->", "w-1"],
    ["a marker with surrounding whitespace", "Hello\n\n   <!-- smithers:write=w-1 -->  \r\n", "w-1"],
    ["a marker with whitespace inside its delimiters", "<!--smithers:write=w-1-->", "w-1"],
    ["a marker with wide inner whitespace", "<!--\n  smithers:write=w-1 \t -->", "w-1"],
    ["two markers, the last of which wins", "<!-- smithers:write=old -->\n\nnew\n\n<!-- smithers:write=new -->", "new"],
    ["a 101-character id", `<!-- smithers:write=${"x".repeat(101)} -->`, undefined],
    ["a sticky key, which is not a write marker", "<!-- smithers:key=w-1 -->", undefined]
  ])("reads the write id of %s", (_name, body, expected) => {
    expect(Issues.writeIdOf(body)).toBe(expected)
  })

  it.each([
    ["text", "Fixes the build."],
    ["an empty body", ""],
    ["a body with trailing newlines", "Line\n\n"],
    ["a body that starts with newlines", "\n\nLine"],
    ["a body with a marker-shaped sticky key", "<!-- smithers:key=k -->\nBody"]
  ])("is removed exactly from %s", (_name, body) => {
    expect(Issues.withoutWriteMarker(Issues.withWriteMarker(body, "w-1"))).toBe(body)
  })

  it("is removed after github.com's editor saves CRLF line ends, and every marker goes", () => {
    expect(Issues.withoutWriteMarker("Edited\r\n\r\n<!-- smithers:write=w-1 -->")).toBe("Edited")
    expect(Issues.withoutWriteMarker("<!--smithers:write=a-->\n\nA\n\n<!-- smithers:write=b -->")).toBe("\n\nA")
    expect(Issues.withoutWriteMarker("No marker here.\n")).toBe("No marker here.\n")
  })
})

describe("getIssue", () => {
  it("decodes the issue, dropping GitHub's other fields and reading a missing state_reason as null", async () => {
    github = await startGitHub()
    const raw = rawIssue(1, "Body")
    delete raw["state_reason"]
    github.issues.push(raw, rawIssue(2, null, { pull_request: { url: "https://api.github.test/pulls/2" } }))
    const issue = await run(Issues.getIssue("o", "r", 1))
    expect(issue).toEqual({
      id: 1001,
      node_id: "I_1",
      number: 1,
      title: "Issue 1",
      body: "Body",
      state: "open",
      state_reason: null,
      user: { id: 1, login: "octocat" },
      labels: [{ name: "bug" }],
      comments: 0,
      created_at: raw["created_at"],
      updated_at: raw["updated_at"],
      closed_at: null
    })
    const pull = await run(Issues.getIssue("o", "r", 2))
    expect(pull.pull_request).toEqual({ url: "https://api.github.test/pulls/2" })
    expect(pull.body).toBeNull()
    expect(github.fixture.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /repos/o/r/issues/1",
      "GET /repos/o/r/issues/2"
    ])
  })

  it("decodes an issue without labels as having none", async () => {
    github = await startGitHub()
    const raw = rawIssue(1, "Body")
    delete raw["labels"]
    github.issues.push(raw, rawIssue(2, "Body", { labels: [] }))
    expect((await run(Issues.getIssue("o", "r", 1))).labels).toEqual([])
    expect((await run(Issues.getIssue("o", "r", 2))).labels).toEqual([])
  })

  it("fails decode-failed when a label has no name", async () => {
    github = await startGitHub()
    github.issues.push(rawIssue(1, "Body", { labels: [{ id: 1, color: "ededed" }] }))
    expect((await failure(Issues.getIssue("o", "r", 1))).reason).toBe("decode-failed")
  })

  it("decodes a closed issue's reason and a deleted author", async () => {
    github = await startGitHub()
    github.issues.push(
      rawIssue(1, "x", { state: "closed", state_reason: "not_planned", closed_at: "2026-10-20T11:00:00Z", user: null })
    )
    expect(await run(Issues.getIssue("o", "r", 1))).toMatchObject({
      state: "closed",
      state_reason: "not_planned",
      closed_at: "2026-10-20T11:00:00Z",
      user: null
    })
  })

  it("fails decode-failed when GitHub's answer does not fit", async () => {
    github = await startGitHub()
    github.issues.push(rawIssue(1, "x", { state: "merged" }))
    expect((await failure(Issues.getIssue("o", "r", 1))).reason).toBe("decode-failed")
  })

  it("passes GitHub's 404 through", async () => {
    github = await startGitHub()
    expect((await failure(Issues.getIssue("o", "r", 9))).details).toMatchObject({ status: 404, retryable: false })
  })

  it.each<[string, string, string, number, Record<string, unknown>]>([
    ["a traversing owner", "..", "r", 1, { field: "owner" }],
    ["a traversing repository", "o", "..", 1, { field: "repo" }],
    ["issue number zero", "o", "r", 0, { field: "number", number: 0 }],
    ["a fractional issue number", "o", "r", 1.5, { field: "number", number: 1.5 }],
    ["an issue number that is a string", "o", "r", "1/../../x" as unknown as number, { number: "string" }]
  ])("refuses %s before any request", async (_name, owner, repo, number, details) => {
    github = await startGitHub()
    const error = await failure(Issues.getIssue(owner, repo, number))
    expect(error.reason).toBe("invalid-config")
    expect(error.details).toMatchObject(details)
    expect(github.fixture.requests).toHaveLength(0)
  })
})

describe("listComments", () => {
  it("lists every comment, oldest first", async () => {
    github = await startGitHub()
    github.comments.set(7, [rawComment(1, 7, "first"), rawComment(2, 7, null)])
    const listed = await run(Issues.listComments("o", "r", 7))
    expect(listed.truncated).toBe(false)
    expect(listed.items.map((comment) => [comment.id, comment.body])).toEqual([[1, "first"], [2, null]])
    expect(listed.items[0]).toEqual({
      id: 1,
      node_id: "IC_1",
      body: "first",
      user: { id: 1, login: "octocat" },
      created_at: expect.any(String),
      updated_at: expect.any(String),
      issue_url: "https://api.github.test/repos/o/r/issues/7"
    })
    expect(query(0).get("since")).toBeNull()
    expect(query(0).get("per_page")).toBe("100")
  })

  it("asks only for comments updated since `since`, and says when the page budget ran out", async () => {
    github = await startGitHub()
    const old = rawComment(1, 7, "old")
    old["updated_at"] = "2026-01-01T00:00:00Z"
    github.comments.set(7, [old, ...[2, 3, 4].map((id) => rawComment(id, 7, `c${id}`))])
    github.pageSize = 1
    const listed = await run(Issues.listComments("o", "r", 7, { since: SINCE, maxPages: 2 }))
    expect(listed.items.map((comment) => comment.id)).toEqual([2, 3])
    expect(listed.truncated).toBe(true)
    expect(query(0).get("since")).toBe(SINCE)
    expect(query(1).get("since")).toBe(SINCE)
    expect(query(1).get("page")).toBe("2")
  })

  it.each([
    ["a `since` that is not a time", { since: "yesterday" }, "since"],
    ["a `since` that is not a string", { since: 5 as unknown as string }, "since"],
    ["an unbounded page budget", { maxPages: Infinity }, "maxPages"]
  ])("refuses %s before any request", async (_name, options, field) => {
    github = await startGitHub()
    const error = await failure(Issues.listComments("o", "r", 7, options))
    expect(error.reason).toBe("invalid-config")
    expect(error.message).toContain(field)
    expect(github.fixture.requests).toHaveLength(0)
  })

  it("fails decode-failed when a comment does not fit", async () => {
    github = await startGitHub()
    github.comments.set(7, [rawComment(1, 7, "ok"), { id: "two" }])
    const error = await failure(Issues.listComments("o", "r", 7))
    expect(error.reason).toBe("decode-failed")
    expect(error.details).toMatchObject({ method: "GET", path: "/repos/o/r/issues/7/comments" })
  })
})

describe("createIssue and createComment", () => {
  it("open an issue and comment on it with the marked bodies", async () => {
    github = await startGitHub()
    const issue = await run(
      Issues.createIssue("o", "r", { title: "Crash on start", body: Issues.withWriteMarker("Steps", "w-1") })
    )
    expect(issue).toMatchObject({ number: 1, title: "Crash on start", state: "open", state_reason: null })
    expect(Issues.writeIdOf(issue.body)).toBe("w-1")
    const comment = await run(Issues.createComment("o", "r", 1, Issues.withWriteMarker("Thanks", "w-2")))
    expect(Issues.withoutWriteMarker(comment.body ?? "")).toBe("Thanks")
    expect(github.writes()).toEqual(["POST /repos/o/r/issues", "POST /repos/o/r/issues/1/comments"])
    expect(JSON.parse(github.fixture.requests[0]!.body)).toEqual({
      title: "Crash on start",
      body: "Steps\n\n<!-- smithers:write=w-1 -->"
    })
    expect(JSON.parse(github.fixture.requests[1]!.body)).toEqual({ body: "Thanks\n\n<!-- smithers:write=w-2 -->" })
  })

  it("refuse traversing coordinates before any request", async () => {
    github = await startGitHub()
    expect((await failure(Issues.createIssue("o", ".", { title: "t", body: "b" }))).reason).toBe("invalid-config")
    expect((await failure(Issues.createComment("o", "r", -1, "b"))).reason).toBe("invalid-config")
    expect((await failure(Issues.createComment("-o", "r", 1, "b"))).reason).toBe("invalid-config")
    expect(github.fixture.requests).toHaveLength(0)
  })
})

describe("findIssueByWrite", () => {
  it("walks the newest-created issues since `since` across pages", async () => {
    github = await startGitHub()
    github.issues.push(rawIssue(1, Issues.withWriteMarker("mine", "w-1")))
    for (let number = 2; number <= 6; number++) github.issues.push(rawIssue(number, `other ${number}`))
    github.pageSize = 2
    const found = await run(Issues.findIssueByWrite("o", "r", { writeId: "w-1", since: SINCE }))
    expect(Option.getOrThrow(found).number).toBe(1)
    expect(github.fixture.requests).toHaveLength(3)
    expect(Object.fromEntries(query(0))).toEqual({
      state: "all",
      sort: "created",
      direction: "desc",
      since: SINCE,
      per_page: "100"
    })
  })

  it("skips pull requests and items that are not issues, and adopts the earliest-created match", async () => {
    github = await startGitHub()
    github.junk = [null, "text", { body: 5 }, { body: Issues.withWriteMarker("broken", "w-other") }]
    github.issues.push(
      rawIssue(1, "unrelated"),
      rawIssue(2, Issues.withWriteMarker("original", "w-1")),
      rawIssue(3, Issues.withWriteMarker("a copy", "w-1")),
      rawIssue(4, Issues.withWriteMarker("a pull request", "w-1"), { pull_request: { url: "u" } })
    )
    const found = await run(Issues.findIssueByWrite("o", "r", { writeId: "w-1", since: SINCE }))
    expect(Option.getOrThrow(found)).toMatchObject({ number: 2, body: "original\n\n<!-- smithers:write=w-1 -->" })
  })

  it("with an author, ignores a copied marker on an older issue someone else wrote", async () => {
    github = await startGitHub()
    github.issues.push(
      rawIssue(1, Issues.withWriteMarker("copied in", "w-1"), { user: { id: 9, login: "mallory" } }),
      rawIssue(2, Issues.withWriteMarker("original", "w-1"), { user: { id: 7, login: "app[bot]" } })
    )
    const found = await run(Issues.findIssueByWrite("o", "r", { writeId: "w-1", since: SINCE, author: "app[bot]" }))
    expect(Option.getOrThrow(found).number).toBe(2)
  })

  it("finds nothing when only a pull request carries the marker", async () => {
    github = await startGitHub()
    github.issues.push(rawIssue(1, Issues.withWriteMarker("pr", "w-1"), { pull_request: { url: "u" } }))
    expect(Option.isNone(await run(Issues.findIssueByWrite("o", "r", { writeId: "w-1", since: SINCE })))).toBe(true)
  })

  it(`fails rather than answer none when the marker is beyond ${RECONCILE_PAGES} pages`, async () => {
    github = await startGitHub()
    github.issues.push(rawIssue(1, Issues.withWriteMarker("too old", "w-1")))
    for (let number = 2; number <= RECONCILE_PAGES + 2; number++) github.issues.push(rawIssue(number, "newer"))
    github.pageSize = 1
    expect(await failure(Issues.findIssueByWrite("o", "r", { writeId: "w-1", since: SINCE }))).toMatchObject({
      reason: "poll-failed",
      details: { incomplete: true, retryable: false }
    })
    expect(github.fixture.requests).toHaveLength(RECONCILE_PAGES)
  })

  it("refuses a copied marker when the original lies beyond the reconciliation budget", async () => {
    github = await startGitHub()
    github.issues.push(rawIssue(1, Issues.withWriteMarker("original", "w-1")))
    for (let number = 2; number <= RECONCILE_PAGES + 1; number++) github.issues.push(rawIssue(number, "newer"))
    github.issues.push(rawIssue(RECONCILE_PAGES + 2, Issues.withWriteMarker("copy", "w-1")))
    github.pageSize = 1
    expect(await failure(Issues.findIssueByWrite("o", "r", { writeId: "w-1", since: SINCE }))).toMatchObject({
      reason: "poll-failed",
      details: { incomplete: true, retryable: false }
    })
  })

  it("fails decode-failed when the marked issue does not fit, rather than writing a second", async () => {
    github = await startGitHub()
    github.issues.push(rawIssue(1, Issues.withWriteMarker("mine", "w-1"), { state: 3 }))
    expect((await failure(Issues.findIssueByWrite("o", "r", { writeId: "w-1", since: SINCE }))).reason).toBe(
      "decode-failed"
    )
  })

  it.each([
    ["an invalid write id", { writeId: "a b", since: SINCE }, "write id"],
    ["an invalid since", { writeId: "w-1", since: "2026-13-45" }, "since"]
  ])("refuses %s before any request", async (_name, options, expected) => {
    github = await startGitHub()
    const error = await failure(Issues.findIssueByWrite("o", "r", options))
    expect(error.reason).toBe("invalid-config")
    expect(error.message).toContain(expected)
    expect(github.fixture.requests).toHaveLength(0)
  })
})

describe("findCommentByWrite", () => {
  it("walks the issue's comments since `since` across pages and adopts the earliest match", async () => {
    github = await startGitHub()
    github.junk = [null]
    github.comments.set(7, [
      rawComment(1, 7, "a"),
      rawComment(2, 7, null),
      rawComment(3, 7, Issues.withWriteMarker("original", "w-1")),
      rawComment(4, 7, Issues.withWriteMarker("a copy", "w-1"))
    ])
    github.pageSize = 2
    const found = await run(Issues.findCommentByWrite("o", "r", 7, { writeId: "w-1", since: SINCE }))
    expect(Option.getOrThrow(found).id).toBe(3)
    expect(query(0).get("since")).toBe(SINCE)
    expect(github.fixture.requests.length).toBeGreaterThanOrEqual(2)
  })

  it("with an author, ignores a copied marker on an earlier comment someone else wrote", async () => {
    github = await startGitHub()
    github.comments.set(7, [
      { ...rawComment(1, 7, Issues.withWriteMarker("copied in", "w-1")), user: { id: 9, login: "mallory" } },
      { ...rawComment(2, 7, Issues.withWriteMarker("original", "w-1")), user: { id: 7, login: "app[bot]" } }
    ])
    const found = await run(Issues.findCommentByWrite("o", "r", 7, { writeId: "w-1", since: SINCE, author: "app[bot]" }))
    expect(Option.getOrThrow(found).id).toBe(2)
  })

  it("finds nothing when no comment carries the marker, reading the whole thread without `since`", async () => {
    github = await startGitHub()
    github.comments.set(7, [rawComment(1, 7, Issues.withWriteMarker("other write", "w-2"))])
    expect(Option.isNone(await run(Issues.findCommentByWrite("o", "r", 7, { writeId: "w-1", since: SINCE }))))
      .toBe(true)
    expect(Option.isNone(await run(Issues.findCommentByWrite("o", "r", 7, { writeId: "w-1" })))).toBe(true)
    expect(query(1).get("since")).toBeNull()
  })

  it(`fails rather than answer none when the thread is longer than ${RECONCILE_PAGES} pages`, async () => {
    github = await startGitHub()
    github.comments.set(7, Array.from({ length: RECONCILE_PAGES + 1 }, (_, i) => rawComment(i + 1, 7, "other")))
    github.pageSize = 1
    expect(await failure(Issues.findCommentByWrite("o", "r", 7, { writeId: "w-1" }))).toMatchObject({
      reason: "poll-failed",
      details: { incomplete: true }
    })
  })

  it("refuses invalid input before any request", async () => {
    github = await startGitHub()
    const options = { writeId: "w-1", since: SINCE }
    expect((await failure(Issues.findCommentByWrite("o", "r", 0, options))).reason).toBe("invalid-config")
    expect((await failure(Issues.findCommentByWrite("o", "r", 7, { ...options, writeId: "" }))).reason).toBe(
      "invalid-config"
    )
    expect((await failure(Issues.findCommentByWrite("o", "r", 7, { ...options, since: "" }))).reason).toBe(
      "invalid-config"
    )
    expect(github.fixture.requests).toHaveLength(0)
  })

  it("fails decode-failed when the marked comment does not fit", async () => {
    github = await startGitHub()
    github.comments.set(7, [{ id: 1, body: Issues.withWriteMarker("mine", "w-1"), updated_at: stamp() }])
    expect((await failure(Issues.findCommentByWrite("o", "r", 7, { writeId: "w-1", since: SINCE }))).reason).toBe(
      "decode-failed"
    )
  })
})

const labelNames = (number: number) =>
  ((github as FakeGitHub).issues.find((issue) => issue["number"] === number)!["labels"] as Array<Raw>).map((label) =>
    label["name"]
  )

describe("addLabels", () => {
  it("posts the names and answers every label the issue carries, narrowed to names", async () => {
    github = await startGitHub()
    github.issues.push(rawIssue(1, "Body"))
    const labels = await run(Issues.addLabels("o", "r", 1, ["smithers:accepted", "BUG", "x".repeat(50)]))
    expect(labels).toEqual([{ name: "bug" }, { name: "smithers:accepted" }, { name: "x".repeat(50) }])
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/1/labels"])
    expect(JSON.parse(github.fixture.requests[0]!.body)).toEqual({
      labels: ["smithers:accepted", "BUG", "x".repeat(50)]
    })
  })

  it("fails retryable and outcomeUnknown, when the answer is lost, and the repeat adds nothing twice", async () => {
    github = await startGitHub()
    github.issues.push(rawIssue(1, "Body"))
    github.lose = true
    const lost = await failure(Issues.addLabels("o", "r", 1, ["smithers:accepted"]))
    expect(lost.reason).toBe("delivery-failed")
    expect(lost.details).toMatchObject({ status: 502, retryable: true, outcomeUnknown: true })
    expect(await run(Issues.addLabels("o", "r", 1, ["smithers:accepted"]))).toEqual([
      { name: "bug" },
      { name: "smithers:accepted" }
    ])
    expect(labelNames(1)).toEqual(["bug", "smithers:accepted"])
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/1/labels", "POST /repos/o/r/issues/1/labels"])
  })

  it("passes GitHub's 404 for a missing issue through", async () => {
    github = await startGitHub()
    const error = await failure(Issues.addLabels("o", "r", 9, ["bug"]))
    expect(error.details).toMatchObject({ status: 404, retryable: false, outcomeUnknown: false })
  })

  it.each<[string, string, number, ReadonlyArray<unknown>, Record<string, unknown>]>([
    ["no names", "o", 1, [], { field: "names" }],
    ["names that are not an array", "o", 1, "bug" as unknown as Array<string>, { field: "names" }],
    ["an empty name", "o", 1, ["bug", ""], { field: "name", name: "" }],
    ["a 51-character name", "o", 1, ["x".repeat(51)], { field: "name", name: "x".repeat(51) }],
    ["a name that is not a string", "o", 1, [7], { field: "name", name: "number" }],
    ["issue number zero", "o", 0, ["bug"], { field: "number" }],
    ["a traversing owner", "..", 1, ["bug"], { field: "owner" }]
  ])("refuses %s before any request", async (_name, owner, number, names, details) => {
    github = await startGitHub()
    const error = await failure(Issues.addLabels(owner, "r", number, names as unknown as [string, ...Array<string>]))
    expect(error.reason).toBe("invalid-config")
    expect(error.details).toMatchObject({ retryable: false, ...details })
    expect(github.fixture.requests).toHaveLength(0)
  })
})

describe("removeLabel", () => {
  it("answers true when GitHub removed the label, encoding its name, and false once it is gone", async () => {
    github = await startGitHub()
    github.issues.push(rawIssue(1, "Body", { labels: [rawLabel("bug"), rawLabel("needs triage/p1?#")] }))
    expect(await run(Issues.removeLabel("o", "r", 1, "needs triage/p1?#"))).toBe(true)
    expect(labelNames(1)).toEqual(["bug"])
    expect(await run(Issues.removeLabel("o", "r", 1, "needs triage/p1?#"))).toBe(false)
    expect(github.fixture.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "DELETE /repos/o/r/issues/1/labels/needs%20triage%2Fp1%3F%23",
      "DELETE /repos/o/r/issues/1/labels/needs%20triage%2Fp1%3F%23"
    ])
  })

  it("answers false for an issue GitHub does not have", async () => {
    github = await startGitHub()
    expect(await run(Issues.removeLabel("o", "r", 9, "bug"))).toBe(false)
  })

  it("fails retryable and outcomeUnknown, when the answer is lost, and the repeat finds the label gone", async () => {
    github = await startGitHub()
    github.issues.push(rawIssue(1, "Body"))
    github.lose = true
    const lost = await failure(Issues.removeLabel("o", "r", 1, "bug"))
    expect(lost.reason).toBe("delivery-failed")
    expect(lost.details).toMatchObject({ status: 502, retryable: true, outcomeUnknown: true })
    expect(await run(Issues.removeLabel("o", "r", 1, "bug"))).toBe(false)
    expect(labelNames(1)).toEqual([])
  })

  it.each<[string, number, unknown, Record<string, unknown>]>([
    ["a label named `.`", 1, ".", { field: "name", name: "." }],
    ["a label named `..`", 1, "..", { field: "name", name: ".." }],
    ["an empty name", 1, "", { field: "name" }],
    ["a 51-character name", 1, "x".repeat(51), { field: "name" }],
    ["a fractional issue number", 1.5, "bug", { field: "number" }]
  ])("refuses %s before any request", async (_name, number, name, details) => {
    github = await startGitHub()
    const error = await failure(Issues.removeLabel("o", "r", number, name as string))
    expect(error.reason).toBe("invalid-config")
    expect(error.details).toMatchObject({ retryable: false, ...details })
    expect(github.fixture.requests).toHaveLength(0)
  })
})

describe("createLabel", () => {
  it("answers true when GitHub created the label, sending a description only when given", async () => {
    github = await startGitHub()
    expect(await run(Issues.createLabel("o", "r", { name: "smithers:accepted", color: "0E8A16" }))).toBe(true)
    const description = "d".repeat(Issues.MAX_LABEL_DESCRIPTION)
    expect(await run(Issues.createLabel("o", "r", { name: "smithers:not-accepted", color: "b60205", description })))
      .toBe(true)
    expect(github.writes()).toEqual(["POST /repos/o/r/labels", "POST /repos/o/r/labels"])
    expect(JSON.parse(github.fixture.requests[0]!.body)).toEqual({ name: "smithers:accepted", color: "0E8A16" })
    expect(JSON.parse(github.fixture.requests[1]!.body)).toEqual({
      name: "smithers:not-accepted",
      color: "b60205",
      description
    })
  })

  it("answers false when GitHub answers 422 because the label exists", async () => {
    github = await startGitHub()
    github.labels.push(rawLabel("smithers:accepted"))
    expect(await run(Issues.createLabel("o", "r", { name: "Smithers:Accepted", color: "0e8a16" }))).toBe(false)
    expect(github.labels).toHaveLength(1)
  })

  it("fails retryable and outcomeUnknown, when the answer is lost, and the repeat finds the label made", async () => {
    github = await startGitHub()
    github.lose = true
    const lost = await failure(Issues.createLabel("o", "r", { name: "smithers:accepted", color: "0e8a16" }))
    expect(lost.reason).toBe("delivery-failed")
    expect(lost.details).toMatchObject({ status: 502, retryable: true, outcomeUnknown: true })
    expect(await run(Issues.createLabel("o", "r", { name: "smithers:accepted", color: "0e8a16" }))).toBe(false)
    expect(github.labels.map((label) => label["name"])).toEqual(["smithers:accepted"])
  })

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["an empty name", { name: "", color: "ededed" }, { field: "name" }],
    ["a color with `#`", { name: "a", color: "#ededed" }, { field: "color", color: "#ededed" }],
    ["a three-digit color", { name: "a", color: "eee" }, { field: "color" }],
    ["a color that is not hex", { name: "a", color: "zzzzzz" }, { field: "color" }],
    ["a color that is not a string", { name: "a", color: 0xededed }, { field: "color", color: "number" }],
    ["a 101-character description", { name: "a", color: "ededed", description: "d".repeat(101) }, {
      field: "description"
    }],
    ["a description that is not a string", { name: "a", color: "ededed", description: 5 }, { field: "description" }]
  ])("refuses %s before any request", async (_name, input, details) => {
    github = await startGitHub()
    const error = await failure(
      Issues.createLabel("o", "r", input as unknown as { readonly name: string; readonly color: string })
    )
    expect(error.reason).toBe("invalid-config")
    expect(error.details).toMatchObject({ retryable: false, ...details })
    expect(github.fixture.requests).toHaveLength(0)
  })

  it("refuses a traversing repository before any request", async () => {
    github = await startGitHub()
    expect((await failure(Issues.createLabel("o", "..", { name: "a", color: "ededed" }))).details).toMatchObject({
      field: "repo"
    })
    expect(github.fixture.requests).toHaveLength(0)
  })
})

/**
 * A step that writes once: POST, and on an attempt after `outcomeUnknown`,
 * find by marker first and adopt what it finds.
 */
const createOnce = (writeId: string, since: string, attempt: number) =>
  Effect.gen(function*() {
    if (attempt > 1) {
      const found = yield* Issues.findIssueByWrite("o", "r", { writeId, since })
      if (Option.isSome(found)) return { issue: found.value, adopted: true }
    }
    const issue = yield* Issues.createIssue("o", "r", {
      title: "Crash",
      body: Issues.withWriteMarker("Steps", writeId)
    })
    return { issue, adopted: false }
  })

describe("a write whose answer was lost", () => {
  it("fails outcomeUnknown, and the next attempt adopts the issue GitHub created", async () => {
    github = await startGitHub()
    github.lose = true
    const lost = await failure(createOnce("w-lost", SINCE, 1))
    expect(lost.reason).toBe("delivery-failed")
    expect(lost.details).toMatchObject({ status: 502, outcomeUnknown: true, retryable: false })
    const retried = await run(createOnce("w-lost", SINCE, 2))
    expect(retried.adopted).toBe(true)
    expect(retried.issue.number).toBe(1)
    expect(github.issues).toHaveLength(1)
    expect(github.writes()).toEqual(["POST /repos/o/r/issues"])
  })

  it("is written once more when GitHub never received it", async () => {
    github = await startGitHub()
    let posts = 0
    // The first POST is answered 502 in place of GitHub and never sent.
    const { handled, transport } = faultingTransport(({ method }) =>
      method === "POST" && ++posts === 1 ? { status: 502, body: { message: "Bad Gateway" } } : undefined
    )
    const client = gitHubLayerOver(transport, { token: "t", apiBaseUrl: github.fixture.origin })
    const attempt = (number: number) => createOnce("w-dropped", SINCE, number).pipe(Effect.provide(client))
    const lost = await Effect.runPromise(Effect.flip(attempt(1)))
    expect(lost.details).toMatchObject({ outcomeUnknown: true })
    expect(github.issues).toHaveLength(0)
    const retried = await Effect.runPromise(attempt(2))
    expect(retried.adopted).toBe(false)
    expect(github.issues).toHaveLength(1)
    expect(handled.map((request) => `${request.method} ${request.path} ${request.faulted ?? "sent"}`)).toEqual([
      "POST /repos/o/r/issues 502",
      "GET /repos/o/r/issues sent",
      "POST /repos/o/r/issues sent"
    ])
  })

  it("on a comment, is found by its marker on the next attempt", async () => {
    github = await startGitHub()
    github.lose = true
    const lost = await failure(Issues.createComment("o", "r", 7, Issues.withWriteMarker("Done", "w-c")))
    expect(lost.details).toMatchObject({ outcomeUnknown: true })
    const found = await run(Issues.findCommentByWrite("o", "r", 7, { writeId: "w-c", since: SINCE }))
    expect(Issues.withoutWriteMarker(Option.getOrThrow(found).body ?? "")).toBe("Done")
    expect(github.comments.get(7)).toHaveLength(1)
  })
})
