/**
 * `GitHub.Once`: each write carries its key, and each lookup finds the object
 * by that key alone, against a stateful fake GitHub on a real socket.
 *
 * The cases put a foreign object beside ours that matches everything but the
 * key (the same branch prefix and label, the same commit message and parent,
 * the same pull request head, the same body text) and assert the lookup never
 * answers it. A listing longer than the page budget fails instead of reading
 * as "not written".
 */
import { Effect, Option } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import { RECONCILE_PAGES } from "../src/github/Actions.ts"
import * as Commits from "../src/github/Commits.ts"
import type { GitHubClient } from "../src/github/GitHubClient.ts"
import * as Issues from "../src/github/Issues.ts"
import * as Once from "../src/github/Once.ts"
import * as Pulls from "../src/github/Pulls.ts"
import * as Refs from "../src/github/Refs.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"
import { gitHubLayer } from "./Http.ts"

type Raw = Record<string, unknown>

const USER = { id: 1, login: "octocat", type: "User", site_admin: false }
const BASE = "a".repeat(40)
const KEY = "0123456789abcdef".repeat(4)
const OTHER_KEY = "fedcba9876543210".repeat(4)
const SINCE = "2026-10-20T00:00:00Z"

let clock = Date.parse("2026-10-20T10:00:00Z")
const stamp = () => new Date(clock += 1000).toISOString()
let nextSha = 1
const sha = () => (nextSha++).toString(16).padStart(40, "c")

interface FakeGitHub {
  readonly fixture: Fixture
  readonly refs: Map<string, string>
  readonly commits: Map<string, Raw>
  readonly pulls: Array<Raw>
  readonly issues: Array<Raw>
  readonly comments: Array<Raw>
  readonly reviews: Array<Raw>
  /** Items each listing page holds at most. */
  pageSize: number
  /** Raw items every ref listing starts with. */
  refJunk: Array<unknown>
  /** The next merge into a branch applies, then answers 502. */
  lose: boolean
}

let github: FakeGitHub | undefined

afterEach(async () => {
  await github?.fixture.close()
  github = undefined
})

const at = (extra: Raw): Raw => {
  const time = stamp()
  return { created_at: time, updated_at: time, ...extra }
}

const startGitHub = async (): Promise<FakeGitHub> => {
  const state = {
    refs: new Map<string, string>([["main", BASE]]),
    commits: new Map<string, Raw>([[BASE, { sha: BASE, message: "Initial", tree: { sha: "t0" }, parents: [] }]]),
    pulls: [] as Array<Raw>,
    issues: [] as Array<Raw>,
    comments: [] as Array<Raw>,
    reviews: [] as Array<Raw>,
    pageSize: 100,
    refJunk: [] as Array<unknown>,
    lose: false
  }
  const fixture: Fixture = await startFixture((request, response) => {
    const url = new URL(request.url, "http://github.test")
    const path = url.pathname
    const body = request.body.length > 0 ? JSON.parse(request.body) : undefined
    const listing = (items: ReadonlyArray<unknown>) => {
      const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 30), state.pageSize)
      const page = Number(url.searchParams.get("page") ?? 1)
      const next = new URL(url.pathname + url.search, fixture.origin)
      next.searchParams.set("page", String(page + 1))
      const headers = page * perPage < items.length ? { link: `<${next}>; rel="next"` } : {}
      return json(response, 200, items.slice((page - 1) * perPage, page * perPage), headers)
    }
    if (path === "/graphql") {
      const input = body.variables.input
      const head = state.refs.get(input.branch.branchName)
      if (head !== input.expectedHeadOid) {
        return json(response, 200, {
          data: { createCommitOnBranch: null },
          errors: [{ type: "STALE_DATA", message: "Expected branch to point to another commit." }]
        })
      }
      const oid = sha()
      state.commits.set(oid, {
        sha: oid,
        message: `${input.message.headline}${input.message.body === undefined ? "" : `\n\n${input.message.body}`}`,
        tree: { sha: `tree-${oid}` },
        parents: [{ sha: head }]
      })
      state.refs.set(input.branch.branchName, oid)
      return json(response, 200, { data: { createCommitOnBranch: { commit: { oid } } } })
    }
    if (path === "/repos/o/r/merges" && request.method === "POST") {
      const into = state.refs.get(body.base)
      const from = state.refs.get(body.head) ?? (state.commits.has(body.head) ? body.head : undefined)
      if (into === undefined || from === undefined) return json(response, 404, { message: "Base or head not found" })
      if (body.head === "conflicting") return json(response, 409, { message: "Merge conflict" })
      // Already holds it: GitHub's 204, no body.
      const holds = (at: string): boolean =>
        at === from ||
        ((state.commits.get(at)?.["parents"] ?? []) as Array<Raw>).some((parent) => holds(parent["sha"] as string))
      if (holds(into)) {
        response.writeHead(204)
        response.end()
        return
      }
      const merged = sha()
      state.commits.set(merged, {
        sha: merged,
        message: body.commit_message ?? `Merge ${body.head} into ${body.base}`,
        tree: { sha: `tree-${merged}` },
        parents: [{ sha: into }, { sha: from }]
      })
      state.refs.set(body.base, merged)
      if (state.lose) {
        state.lose = false
        return json(response, 502, { message: "Bad Gateway" })
      }
      return json(response, 201, { sha: merged, commit: { message: "merge" } })
    }
    const matching = /^\/repos\/o\/r\/git\/matching-refs\/heads\/(.+)$/.exec(path)
    if (matching !== null) {
      return listing([
        ...state.refJunk,
        ...[...state.refs].filter(([name]) => name.startsWith(matching[1]!)).map(([name, head]) => ({
          ref: `refs/heads/${name}`,
          object: { sha: head, type: "commit" }
        }))
      ])
    }
    if (path === "/repos/o/r/git/refs" && request.method === "POST") {
      const name = (body.ref as string).replace(/^refs\/heads\//, "")
      if (state.refs.has(name)) return json(response, 422, { message: "Reference already exists" })
      state.refs.set(name, body.sha)
      return json(response, 201, { ref: body.ref, object: { sha: body.sha, type: "commit" } })
    }
    const ref = /^\/repos\/o\/r\/git\/ref\/heads\/(.+)$/.exec(path)
    if (ref !== null) {
      const head = state.refs.get(ref[1]!)
      if (head === undefined) return json(response, 404, { message: "Not Found" })
      return json(response, 200, { ref: `refs/heads/${ref[1]}`, object: { sha: head, type: "commit" } })
    }
    const commit = /^\/repos\/o\/r\/git\/commits\/([0-9a-f]{40})$/.exec(path)
    if (commit !== null) {
      const found = state.commits.get(commit[1]!)
      return found === undefined ? json(response, 404, { message: "Not Found" }) : json(response, 200, found)
    }
    if (path === "/repos/o/r/pulls" && request.method === "POST") {
      const number = state.pulls.length + 1
      const pull = at({
        id: 7000 + number,
        node_id: `PR_${number}`,
        number,
        title: body.title,
        body: body.body,
        state: "open",
        draft: false,
        user: USER,
        head: { ref: body.head, sha: state.refs.get(body.head) },
        base: { ref: body.base, sha: state.refs.get(body.base) },
        closed_at: null,
        merged_at: null,
        merge_commit_sha: null
      })
      state.pulls.push(pull)
      return json(response, 201, pull)
    }
    const pullPath = /^\/repos\/o\/r\/pulls\/(\d+)(\/merge)?$/.exec(path)
    if (pullPath !== null) {
      const pull = state.pulls[Number(pullPath[1]) - 1]
      if (pull === undefined) return json(response, 404, { message: "Not Found" })
      if (pullPath[2] === undefined) return json(response, 200, pull)
      const head = pull["head"] as Raw
      const base = pull["base"] as Raw
      if (pull["merged"] === true) return json(response, 405, { message: "Pull Request is not mergeable" })
      if (head["sha"] !== body.sha) return json(response, 409, { message: "Head branch was modified" })
      // A rebase writes the head's commits again with their own messages; squash and merge write the one given.
      const message = body.merge_method === "rebase"
        ? "Rebased commit"
        : `${body.commit_title ?? "Merged"}${body.commit_message === undefined ? "" : `\n\n${body.commit_message}`}`
      const oid = sha()
      state.commits.set(oid, {
        sha: oid,
        message,
        tree: { sha: `tree-${oid}` },
        parents: [{ sha: state.refs.get(base["ref"] as string) }]
      })
      state.refs.set(base["ref"] as string, oid)
      Object.assign(pull, { merged: true, merge_commit_sha: oid, merged_by: USER, state: "closed" })
      return json(response, 200, { sha: oid, merged: true, message: "Pull Request successfully merged" })
    }
    if (path === "/repos/o/r/pulls") {
      const head = url.searchParams.get("head")
      return listing(state.pulls.filter((pull) => `o:${(pull["head"] as Raw)["ref"]}` === head))
    }
    if (path === "/repos/o/r/issues" && request.method === "POST") {
      const number = 100 + state.issues.length
      const issue = at({
        id: 1000 + number,
        node_id: `I_${number}`,
        number,
        title: body.title,
        body: body.body,
        state: "open",
        state_reason: null,
        user: USER,
        labels: [],
        comments: 0,
        closed_at: null,
        html_url: `https://github.test/o/r/issues/${number}`
      })
      state.issues.push(issue)
      return json(response, 201, issue)
    }
    if (path === "/repos/o/r/issues") return listing([...state.issues].reverse())
    if (path === "/repos/o/r/issues/7/comments") {
      if (request.method === "GET") return listing(state.comments)
      const comment = at({
        id: 5000 + state.comments.length,
        node_id: `IC_${state.comments.length}`,
        body: body.body,
        user: USER,
        html_url: "https://github.test/o/r/issues/7#c",
        issue_url: "https://api.github.test/repos/o/r/issues/7",
        author_association: "OWNER"
      })
      state.comments.push(comment)
      return json(response, 201, comment)
    }
    if (path === "/repos/o/r/pulls/7/reviews") {
      if (request.method === "GET") return listing(state.reviews)
      const review = {
        id: 9000 + state.reviews.length,
        node_id: `PRR_${state.reviews.length}`,
        body: body.body,
        state: "COMMENTED",
        user: USER,
        commit_id: body.commit_id,
        submitted_at: stamp(),
        html_url: "https://github.test/o/r/pull/7#r"
      }
      state.reviews.push(review)
      return json(response, 200, review)
    }
    return json(response, 404, { message: `Not Found: ${request.method} ${path}` })
  })
  const fake = {
    fixture,
    get pageSize() {
      return state.pageSize
    },
    set pageSize(value: number) {
      state.pageSize = value
    },
    get refJunk() {
      return state.refJunk
    },
    set refJunk(value: Array<unknown>) {
      state.refJunk = value
    },
    get lose() {
      return state.lose
    },
    set lose(value: boolean) {
      state.lose = value
    },
    refs: state.refs,
    commits: state.commits,
    pulls: state.pulls,
    issues: state.issues,
    comments: state.comments,
    reviews: state.reviews
  }
  return fake
}

const layer = () => gitHubLayer({ token: "t", apiBaseUrl: (github as FakeGitHub).fixture.origin }, {})

const run = <A>(effect: Effect.Effect<A, IntegrationError, GitHubClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer())))

const failure = <A>(effect: Effect.Effect<A, IntegrationError, GitHubClient>): Promise<IntegrationError> =>
  Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(layer())))

const writes = () => (github as FakeGitHub).fixture.requests.filter((request) => request.method !== "GET").length

describe("trailers and branch names", () => {
  it("put the key in a trailer after a blank line, and read the last one back", () => {
    expect(Once.withTrailer("T1: Fix\n\nSmithers for @maya", KEY)).toBe(
      `T1: Fix\n\nSmithers for @maya\n\nSmithers-Write: ${KEY}`
    )
    expect(Once.withTrailer("", KEY)).toBe(`Smithers-Write: ${KEY}`)
    expect(Once.trailerKeyOf(`a\n\nSmithers-Write: ${OTHER_KEY}\nSmithers-Write: ${KEY}`)).toBe(KEY)
    expect(Once.trailerKeyOf(`a\n\nSmithers-Write: ${KEY.slice(1)}`)).toBeUndefined()
    expect(Once.trailerKeyOf("T1: Fix\n\nSmithers for @maya")).toBeUndefined()
  })

  it("end a branch name in the key's first 12 hex digits", () => {
    expect(Once.branchName("smithers/t1-", "fix-login", KEY)).toBe("smithers/t1-fix-login-0123456789ab")
    expect(Once.branchName("smithers/t1-", "", KEY)).toBe("smithers/t1-0123456789ab")
  })
})

describe("branch", () => {
  const made = (label: string, read: Array<string>) =>
    Once.branch("o", "r", {
      prefix: "smithers/t1-",
      label,
      at: Effect.sync(() => {
        read.push("at")
        return BASE
      })
    })

  it("makes the branch at `at`, and finds it by its key whatever its label, never a look-alike", async () => {
    github = await startGitHub()
    const read: Array<string> = []
    // Someone else's branch with the same prefix and label, at the same base.
    github.refs.set(`smithers/t1-fix-login-${OTHER_KEY.slice(0, 12)}`, BASE)
    github.refs.set("smithers/t1-fix-login", BASE)
    expect(Option.isNone(await run(made("fix-login", read).find(KEY)))).toBe(true)
    expect(read).toEqual([])
    const branch = await run(made("fix-login", read).perform(KEY))
    expect(branch).toEqual({ name: "smithers/t1-fix-login-0123456789ab", sha: BASE })
    expect(read).toEqual(["at"])
    // A later run with another label, after the default branch moved: the same branch.
    github.refs.set("main", "d".repeat(40))
    expect(await run(made("renamed", read).find(KEY))).toEqual(Option.some(branch))
    expect(read).toEqual(["at"])
  })

  it("finds an unlabeled branch, and fails when the listing runs out of pages", async () => {
    github = await startGitHub()
    github.refs.set("smithers/t1-0123456789ab", BASE)
    expect(Option.getOrThrow(await run(made("", []).find(KEY))).name).toBe("smithers/t1-0123456789ab")
    github.refs.delete("smithers/t1-0123456789ab")
    for (let n = 0; n <= RECONCILE_PAGES; n++) github.refs.set(`smithers/t1-other-${n}`, BASE)
    github.pageSize = 1
    expect(await failure(made("", []).find(KEY))).toMatchObject({ reason: "poll-failed" })
  })

  it("lists only branches, fails on a ref it cannot read, and refuses a prefix that is not a branch name", async () => {
    github = await startGitHub()
    github.refs.set("smithers/t1-a", BASE)
    github.refJunk = [{ ref: "refs/tags/smithers/t1-v1", object: { sha: BASE, type: "commit" } }]
    expect(await run(Refs.listBranches("o", "r", "smithers/"))).toEqual({
      items: [{ name: "smithers/t1-a", sha: BASE }],
      truncated: false
    })
    github.refJunk = [{ ref: 5 }]
    expect(await failure(Refs.listBranches("o", "r", "smithers/"))).toMatchObject({ reason: "decode-failed" })
    expect(await failure(Refs.listBranches("o", "r", "../x"))).toMatchObject({ reason: "invalid-config" })
    expect(github.fixture.requests).toHaveLength(2)
  })
})

describe("commitOnBranch", () => {
  const change = {
    branch: "smithers/t1-fix",
    expectedHeadOid: BASE,
    headline: "T1: Fix",
    body: "Smithers for @maya",
    additions: [{ path: "A.md", contents: btoa("a\n") }],
    deletions: []
  }

  it("writes the trailer, finds the commit by it, and finds nothing while the branch is at the base", async () => {
    github = await startGitHub()
    github.refs.set("smithers/t1-fix", BASE)
    const keyed = Once.commitOnBranch("o", "r", change)
    expect(Option.isNone(await run(keyed.find(KEY)))).toBe(true)
    const made = await run(keyed.perform(KEY))
    expect(github.commits.get(made)!["message"]).toBe(`T1: Fix\n\nSmithers for @maya\n\nSmithers-Write: ${KEY}`)
    expect(await run(keyed.find(KEY))).toEqual(Option.some(made))
    expect(Option.isNone(await run(Once.commitOnBranch("o", "r", { ...change, branch: "gone" }).find(KEY)))).toBe(true)
    const bare = await run(
      Once.commitOnBranch("o", "r", { ...change, body: undefined, expectedHeadOid: made }).perform(
        OTHER_KEY
      )
    )
    expect(github.commits.get(bare)!["message"]).toBe(`T1: Fix\n\nSmithers-Write: ${OTHER_KEY}`)
  })

  it("never adopts a foreign commit with the same headline, body and parent: it fails stale", async () => {
    github = await startGitHub()
    const foreign = sha()
    github.commits.set(foreign, {
      sha: foreign,
      message: "T1: Fix\n\nSmithers for @maya",
      tree: { sha: "t" },
      parents: [{ sha: BASE }]
    })
    github.refs.set("smithers/t1-fix", foreign)
    const keyed = Once.commitOnBranch("o", "r", change)
    expect(await failure(keyed.find(KEY))).toMatchObject({ details: { status: 409, stale: true, retryable: false } })
    // Another write's commit is not this one's either.
    expect(await failure(keyed.perform(KEY))).toMatchObject({ details: { status: 409, stale: true } })
    expect(github.refs.get("smithers/t1-fix")).toBe(foreign)
  })
})

describe("pull, issue, comment and review", () => {
  it("open one pull request per key, and never answer one from the same head without it", async () => {
    github = await startGitHub()
    github.refs.set("smithers/t1-fix", "e".repeat(40))
    const keyed = Once.pull("o", "r", { head: "smithers/t1-fix", base: "main", title: "T1: Fix", body: "Do it." })
    await run(Pulls.createPull("o", "r", { head: "smithers/t1-fix", base: "main", title: "T1: Fix", body: "Do it." }))
    expect(Option.isNone(await run(keyed.find(KEY)))).toBe(true)
    const pull = await run(keyed.perform(KEY))
    expect(pull.body).toBe(Issues.withWriteMarker("Do it.", KEY))
    expect(Option.getOrThrow(await run(keyed.find(KEY))).number).toBe(pull.number)
  })

  it("make an issue, a comment and a review carrying the key, found by it alone", async () => {
    github = await startGitHub()
    const issue = Once.issue("o", "r", { title: "Bug", body: "Broken.", since: SINCE })
    const comment = Once.comment("o", "r", 7, "Thanks.")
    const review = Once.review("o", "r", 7, { commitId: BASE, event: "COMMENT", body: "Looks off." })
    // The same text without the key, made by someone else first.
    await run(Issues.createIssue("o", "r", { title: "Bug", body: "Broken." }))
    await run(Issues.createComment("o", "r", 7, "Thanks."))
    await run(Pulls.createReview("o", "r", 7, { commitId: BASE, event: "COMMENT", body: "Looks off." }))
    const finds: ReadonlyArray<(key: string) => Effect.Effect<Option.Option<unknown>, IntegrationError, GitHubClient>> =
      [
        issue.find,
        comment.find,
        review.find
      ]
    for (const find of finds) expect(Option.isNone(await run(find(KEY)))).toBe(true)
    const madeIssue = await run(issue.perform(KEY))
    const madeComment = await run(comment.perform(KEY))
    const madeReview = await run(review.perform(KEY))
    expect([madeIssue.body, madeComment.body, madeReview.body]).toEqual([
      Issues.withWriteMarker("Broken.", KEY),
      Issues.withWriteMarker("Thanks.", KEY),
      Issues.withWriteMarker("Looks off.", KEY)
    ])
    expect(Option.getOrThrow(await run(issue.find(KEY))).number).toBe(madeIssue.number)
    expect(Option.getOrThrow(await run(comment.find(KEY))).id).toBe(madeComment.id)
    expect(Option.getOrThrow(await run(review.find(KEY))).id).toBe(madeReview.id)
    expect(writes()).toBe(6)
  })

  it("fail rather than answer none when a listing runs out of pages", async () => {
    github = await startGitHub()
    github.refs.set("smithers/t1-fix", "e".repeat(40))
    for (let n = 0; n <= RECONCILE_PAGES; n++) {
      await run(Issues.createIssue("o", "r", { title: `t${n}`, body: "x" }))
      await run(Issues.createComment("o", "r", 7, "x"))
      await run(Pulls.createReview("o", "r", 7, { commitId: BASE, event: "COMMENT", body: "x" }))
      await run(Pulls.createPull("o", "r", { head: "smithers/t1-fix", base: "main", title: "t", body: "x" }))
    }
    github.pageSize = 1
    const finds: ReadonlyArray<(key: string) => Effect.Effect<Option.Option<unknown>, IntegrationError, GitHubClient>> =
      [
        Once.issue("o", "r", { title: "t", body: "b", since: SINCE }).find,
        Once.comment("o", "r", 7, "b").find,
        Once.review("o", "r", 7, { commitId: BASE, event: "COMMENT", body: "b" }).find,
        Once.pull("o", "r", { head: "smithers/t1-fix", base: "main", title: "t", body: "b" }).find
      ]
    for (const find of finds) {
      expect(await failure(find(KEY))).toMatchObject({
        reason: "poll-failed",
        details: { incomplete: true, retryable: false }
      })
    }
  })
})

describe("merge", () => {
  /** Pull request #1 from `smithers/t1-fix` into main, at head `e…`. */
  const opened = async () => {
    github = await startGitHub()
    github.refs.set("smithers/t1-fix", "e".repeat(40))
    return run(Pulls.createPull("o", "r", { head: "smithers/t1-fix", base: "main", title: "T1: Fix", body: "Do it." }))
  }
  const squash = (pull: Pulls.PullRequest) =>
    Once.merge("o", "r", pull.number, { sha: pull.head.sha, method: "squash", commitTitle: "T1: Fix (#1)" })

  it("merges at the head with the key's trailer, and finds that merge by it alone", async () => {
    const pull = await opened()
    const keyed = squash(pull)
    expect(Option.isNone(await run(keyed.find(KEY)))).toBe(true)
    const merged = await run(keyed.perform(KEY))
    expect(merged.merged).toBe(true)
    expect((github as FakeGitHub).commits.get(merged.sha)!["message"]).toBe(`T1: Fix (#1)\n\nSmithers-Write: ${KEY}`)
    expect(await run(keyed.find(KEY))).toEqual(Option.some({ sha: merged.sha, merged: true }))
    // Another write's key finds nothing: the merge is this one's.
    expect(Option.isNone(await run(keyed.find(OTHER_KEY)))).toBe(true)
    const withMessage = Once.merge("o", "r", pull.number, { sha: pull.head.sha, method: "merge", commitMessage: "Why" })
    expect(Option.isNone(await run(withMessage.find(OTHER_KEY)))).toBe(true)
  })

  it("never adopts a merge someone else made at the same head, and keeps the head fence", async () => {
    const pull = await opened()
    // Merged on github.com, with GitHub's own message: no trailer.
    await run(Pulls.mergePull("o", "r", pull.number, { sha: pull.head.sha, method: "squash" }))
    expect(Option.isNone(await run(squash(pull).find(KEY)))).toBe(true)
    const moved = await run(
      Pulls.createPull("o", "r", { head: "smithers/t1-fix", base: "main", title: "T2", body: "x" })
    )
    const fenced = Once.merge("o", "r", moved.number, { sha: "f".repeat(40), method: "squash" })
    expect(await failure(fenced.perform(KEY))).toMatchObject({ details: { status: 409 } })
  })

  it("preserves a merge message and recovers only the final key trailer", async () => {
    const pull = await opened()
    const keyed = Once.merge("o", "r", pull.number, {
      sha: pull.head.sha,
      method: "merge",
      commitMessage: `Why\n\nSmithers-Write: ${OTHER_KEY}`
    })
    const merged = await run(keyed.perform(KEY))
    expect((github as FakeGitHub).commits.get(merged.sha)!["message"])
      .toBe(`Merged\n\nWhy\n\nSmithers-Write: ${OTHER_KEY}\n\nSmithers-Write: ${KEY}`)
    expect(await run(keyed.find(KEY))).toEqual(Option.some({ sha: merged.sha, merged: true }))
    expect(Option.isNone(await run(keyed.find(OTHER_KEY)))).toBe(true)
  })

  it("cannot recover a merged pull without its merge SHA and propagates a missing commit read", async () => {
    const pull = await opened()
    const raw = (github as FakeGitHub).pulls[0]!
    Object.assign(raw, { merged: true, merge_commit_sha: null })
    expect(Option.isNone(await run(squash(pull).find(KEY)))).toBe(true)
    raw["merge_commit_sha"] = "f".repeat(40)
    expect(await failure(squash(pull).find(KEY))).toMatchObject({ details: { status: 404 } })
  })

  it("never finds a rebase merge, since a rebase writes no message to carry the key", async () => {
    const pull = await opened()
    const rebase = Once.merge("o", "r", pull.number, { sha: pull.head.sha, method: "rebase" })
    const merged = await run(rebase.perform(KEY))
    expect(merged.merged).toBe(true)
    // Merged by this very call, and still not provably this write's: a lost answer reads as someone else's merge.
    expect(Option.isNone(await run(rebase.find(KEY)))).toBe(true)
  })
})

describe("mergeInto", () => {
  /** `t2` one commit past `BASE`, and `main` moved on by a squash `t2` lacks. */
  const stacked = async () => {
    const fake = await startGitHub()
    github = fake
    const t2 = sha()
    fake.commits.set(t2, { sha: t2, message: "T2: Another line", tree: { sha: "t2" }, parents: [{ sha: BASE }] })
    fake.refs.set("t2", t2)
    const squash = sha()
    fake.commits.set(squash, { sha: squash, message: "T1 (#1)", tree: { sha: "ts" }, parents: [{ sha: BASE }] })
    fake.refs.set("main", squash)
    return { fake, t2, squash }
  }
  const mainIntoT2 = () => Once.mergeInto("o", "r", { base: "t2", head: "main", commitMessage: "Merge main into t2" })

  it("merges with the key's trailer, finds that merge by it alone, and answers up to date after", async () => {
    const { fake, t2, squash } = await stacked()
    expect(Option.isNone(await run(mainIntoT2().find(KEY)))).toBe(true)
    const merged = await run(mainIntoT2().perform(KEY))
    const mergeSha = fake.refs.get("t2")!
    expect(merged).toEqual({ kind: "merged", sha: mergeSha })
    expect(fake.commits.get(mergeSha)).toMatchObject({
      message: `Merge main into t2\n\nSmithers-Write: ${KEY}`,
      parents: [{ sha: t2 }, { sha: squash }]
    })
    expect(await run(mainIntoT2().find(KEY))).toEqual(Option.some(merged))
    expect(Option.isNone(await run(mainIntoT2().find(OTHER_KEY)))).toBe(true)
    // `t2` already holds `main`: GitHub's 204, answered unchanged, and the branch stays put.
    expect(await run(mainIntoT2().perform(OTHER_KEY))).toEqual({ kind: "upToDate" })
    expect(fake.refs.get("t2")).toBe(mergeSha)
    // A head given by SHA, with no message of its own: the message is the trailer alone.
    const next = sha()
    fake.commits.set(next, { sha: next, message: "T3", tree: { sha: "t3" }, parents: [{ sha: squash }] })
    const bySha = Once.mergeInto("o", "r", { base: "t2", head: next })
    const again = await run(bySha.perform(OTHER_KEY))
    expect(fake.commits.get(fake.refs.get("t2")!)!["message"]).toBe(`Smithers-Write: ${OTHER_KEY}`)
    expect(await run(bySha.find(OTHER_KEY))).toEqual(Option.some(again))
    expect(writes()).toBe(3)
  })

  it("adopts a merge whose answer was lost, by its trailer key", async () => {
    const { fake } = await stacked()
    fake.lose = true
    const lost = await failure(mainIntoT2().perform(KEY))
    expect(lost.details).toMatchObject({ status: 502, retryable: true })
    expect(await run(mainIntoT2().find(KEY))).toEqual(Option.some({ kind: "merged", sha: fake.refs.get("t2") }))
    expect(writes()).toBe(1)
  })

  it("never adopts someone else's merge at the head; merging again answers up to date", async () => {
    const { fake, t2 } = await stacked()
    // A person merged main into t2 with the same message and no trailer.
    await run(Commits.mergeInto("o", "r", { base: "t2", head: "main", commitMessage: "Merge main into t2" }))
    const theirs = fake.refs.get("t2")
    expect(theirs).not.toBe(t2)
    expect(Option.isNone(await run(mainIntoT2().find(KEY)))).toBe(true)
    expect(await run(mainIntoT2().perform(KEY))).toEqual({ kind: "upToDate" })
    expect(fake.refs.get("t2")).toBe(theirs)
  })

  it("loses sight of its merge under a commit pushed on top, and merging again answers up to date", async () => {
    const { fake } = await stacked()
    await run(mainIntoT2().perform(KEY))
    const pushed = sha()
    fake.commits.set(pushed, {
      sha: pushed,
      message: "Fix a typo",
      tree: { sha: "tp" },
      parents: [{ sha: fake.refs.get("t2") }]
    })
    fake.refs.set("t2", pushed)
    expect(Option.isNone(await run(mainIntoT2().find(KEY)))).toBe(true)
    expect(await run(mainIntoT2().perform(KEY))).toEqual({ kind: "upToDate" })
    expect(fake.refs.get("t2")).toBe(pushed)
  })

  it("finds nothing on a branch that is gone, and refuses it (404) and a conflict (409), unretried", async () => {
    const { fake } = await stacked()
    const gone = Once.mergeInto("o", "r", { base: "gone", head: "main" })
    expect(Option.isNone(await run(gone.find(KEY)))).toBe(true)
    expect((await failure(gone.perform(KEY))).details).toMatchObject({ status: 404, retryable: false })
    fake.refs.set("conflicting", sha())
    const before = fake.refs.get("t2")
    const conflict = Once.mergeInto("o", "r", { base: "t2", head: "conflicting" })
    expect((await failure(conflict.perform(KEY))).details).toMatchObject({
      status: 409,
      retryable: false,
      outcomeUnknown: false
    })
    expect(fake.refs.get("t2")).toBe(before)
    const requests = fake.fixture.requests.length
    expect((await failure(Once.mergeInto("o", "r", { base: "../t2", head: "main" }).find(KEY))).reason).toBe(
      "invalid-config"
    )
    expect(fake.fixture.requests).toHaveLength(requests)
  })
})
