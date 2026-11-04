/**
 * Commit statuses against a fake GitHub on a real socket.
 *
 * The fake keeps every status it is sent per commit, as GitHub does, so the
 * cases assert on what a commit ends up showing: the latest state per context,
 * a repeat after a lost answer changing nothing anyone reads, and a refusal
 * passed through unretried.
 */
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import type { GitHubClient } from "../src/github/GitHubClient.ts"
import * as Statuses from "../src/github/Statuses.vibe"
import { type Fixture, json, startFixture } from "./Fixture.ts"
import { gitHubLayer } from "./Http.ts"

const HEAD = "a".repeat(40)
const OLDER = "b".repeat(40)

interface FakeGitHub {
  readonly fixture: Fixture
  /** Every status per commit, in the order received. */
  readonly statuses: Map<string, Array<Record<string, unknown>>>
  /** The next write applies, then answers 502. */
  lose: boolean
  /** The next write answers this status without applying. */
  refuse: number | undefined
}

let github: FakeGitHub | undefined

afterEach(async () => {
  await github?.fixture.close()
  github = undefined
})

const startGitHub = async (): Promise<FakeGitHub> => {
  const state = {
    statuses: new Map<string, Array<Record<string, unknown>>>(),
    lose: false,
    refuse: undefined as number | undefined
  }
  let id = 1
  const fixture = await startFixture((request, response) => {
    const match = /^\/repos\/o\/r\/statuses\/([0-9a-f]+)$/.exec(new URL(request.url, "http://github.test").pathname)
    if (match === null || request.method !== "POST") return json(response, 404, { message: "Not Found" })
    if (state.refuse !== undefined) {
      const status = state.refuse
      state.refuse = undefined
      return json(response, status, {
        message: status === 422 ? "No commit found for SHA" : "Resource not accessible by integration"
      })
    }
    const body = JSON.parse(request.body) as Record<string, string>
    const status = {
      id: id++,
      state: body["state"],
      context: body["context"],
      description: body["description"] ?? null,
      target_url: body["target_url"] ?? null,
      created_at: "2026-10-21T18:00:00Z"
    }
    state.statuses.set(match[1]!, [...(state.statuses.get(match[1]!) ?? []), status])
    if (state.lose) {
      state.lose = false
      return json(response, 502, { message: "Bad Gateway" })
    }
    json(response, 201, status)
  })
  github = Object.assign(state, { fixture })
  return github
}

const layer = () => gitHubLayer({ token: "token-for-tests", apiBaseUrl: github!.fixture.origin }, {})

const run = <A>(effect: Effect.Effect<A, IntegrationError, GitHubClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer())))

const failure = <A>(effect: Effect.Effect<A, IntegrationError, GitHubClient>): Promise<IntegrationError> =>
  Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(layer())))

/** What a commit shows: the latest state per context, as GitHub's combined status does. */
const shown = (sha: string) =>
  Object.fromEntries((github!.statuses.get(sha) ?? []).map((status) => [status["context"], status["state"]]))

describe("create", () => {
  it("reports a check running, then its result, on the exact commit", async () => {
    await startGitHub()
    const pending = await run(Statuses.create("o", "r", HEAD, { state: "pending", context: "smithers/lint" }))
    expect(pending).toMatchObject({ state: "pending", context: "smithers/lint", description: null, target_url: null })
    await run(Statuses.create("o", "r", HEAD, {
      state: "success",
      context: "smithers/lint",
      description: "Passed",
      targetUrl: "https://smithers.example/o/r/pull/7/checks"
    }))
    expect(shown(HEAD)).toEqual({ "smithers/lint": "success" })
    expect(github!.statuses.get(HEAD)!.at(-1)).toMatchObject({
      description: "Passed",
      target_url: "https://smithers.example/o/r/pull/7/checks"
    })
    expect(github!.fixture.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `POST /repos/o/r/statuses/${HEAD}`,
      `POST /repos/o/r/statuses/${HEAD}`
    ])
    expect(github!.fixture.requests[0]!.headers["authorization"]).toBe("Bearer token-for-tests")
  })

  it("keeps each commit's statuses its own: an older head's failure never shows on the newer one", async () => {
    await startGitHub()
    await run(Statuses.create("o", "r", OLDER, { state: "failure", context: "smithers/lint" }))
    await run(Statuses.create("o", "r", HEAD, { state: "success", context: "smithers/lint" }))
    await run(Statuses.create("o", "r", HEAD, { state: "error", context: "smithers/review" }))
    expect(shown(OLDER)).toEqual({ "smithers/lint": "failure" })
    expect(shown(HEAD)).toEqual({ "smithers/lint": "success", "smithers/review": "error" })
  })

  it("accepts a SHA-256 repository's 64-digit commit", async () => {
    await startGitHub()
    const sha256 = "c".repeat(64)
    await run(Statuses.create("o", "r", sha256, { state: "success", context: "smithers/test" }))
    expect(shown(sha256)).toEqual({ "smithers/test": "success" })
  })

  it("cuts a description longer than GitHub stores, rather than have GitHub refuse it", async () => {
    await startGitHub()
    await run(
      Statuses.create("o", "r", HEAD, { state: "failure", context: "smithers/lint", description: "x".repeat(300) })
    )
    const sent = JSON.parse(github!.fixture.requests[0]!.body) as { description: string }
    expect(sent.description).toHaveLength(Statuses.MAX_DESCRIPTION)
    expect(sent.description.endsWith("…")).toBe(true)
    const exact = "y".repeat(Statuses.MAX_DESCRIPTION)
    await run(Statuses.create("o", "r", HEAD, { state: "failure", context: "smithers/lint", description: exact }))
    expect((JSON.parse(github!.fixture.requests[1]!.body) as { description: string }).description).toBe(exact)
  })

  it("marks a lost answer retryable and outcome-unknown: sending the same state again changes nothing anyone reads", async () => {
    await startGitHub()
    github!.lose = true
    const lost = await failure(Statuses.create("o", "r", HEAD, { state: "success", context: "smithers/lint" }))
    expect(lost.details).toMatchObject({ status: 502, retryable: true })
    expect(lost.details?.["outcomeUnknown"]).toBe(true)
    await run(Statuses.create("o", "r", HEAD, { state: "success", context: "smithers/lint" }))
    expect(github!.statuses.get(HEAD)).toHaveLength(2)
    expect(shown(HEAD)).toEqual({ "smithers/lint": "success" })
  })

  it.each([
    [403, "a token without statuses: write"],
    [404, "a repository the token can't see"],
    [422, "a commit GitHub doesn't have"]
  ])("passes GitHub's %i (%s) through, unretried", async (status) => {
    await startGitHub()
    github!.refuse = status
    const refused = await failure(Statuses.create("o", "r", HEAD, { state: "success", context: "smithers/lint" }))
    expect(refused.reason).toBe("delivery-failed")
    expect(refused.details).toMatchObject({ status, retryable: false })
    expect(github!.statuses.size).toBe(0)
  })

  it.each<[string, string, Statuses.Input]>([
    ["sha", "a short SHA", { state: "success", context: "smithers/lint" }],
    ["sha", "an uppercase SHA", { state: "success", context: "smithers/lint" }],
    ["state", "an unknown state", { state: "passed" as Statuses.State, context: "smithers/lint" }],
    ["context", "an empty context", { state: "success", context: "" }],
    ["context", "a context with a newline", { state: "success", context: "smithers/\nlint" }],
    ["context", "a context with a trailing space", { state: "success", context: "smithers/lint " }],
    ["context", "a 256-character context", { state: "success", context: "s".repeat(256) }],
    ["targetUrl", "an http target URL", {
      state: "success",
      context: "smithers/lint",
      targetUrl: "http://smithers.example/x"
    }],
    ["targetUrl", "a relative target URL", { state: "success", context: "smithers/lint", targetUrl: "/o/r/pull/7" }]
  ])("refuses %s: %s, before any request", async (field, label, input) => {
    await startGitHub()
    const sha = label === "a short SHA" ? "abc123" : label === "an uppercase SHA" ? "A".repeat(40) : HEAD
    const refused = await failure(Statuses.create("o", "r", sha, input))
    expect(refused.reason).toBe("invalid-config")
    expect(refused.details).toMatchObject({ field, retryable: false })
    expect(github!.fixture.requests).toHaveLength(0)
  })

  it("refuses a SHA that isn't a string, naming its type", async () => {
    await startGitHub()
    const refused = await failure(
      Statuses.create("o", "r", 7 as unknown as string, { state: "success", context: "smithers/lint" })
    )
    expect(refused.details).toMatchObject({ field: "sha", value: "number", retryable: false })
    expect(github!.fixture.requests).toHaveLength(0)
  })

  it("accepts the longest context GitHub takes", async () => {
    await startGitHub()
    await run(Statuses.create("o", "r", HEAD, { state: "success", context: "s".repeat(255) }))
    expect(shown(HEAD)).toEqual({ ["s".repeat(255)]: "success" })
  })

  it("refuses a repository path that isn't one", async () => {
    await startGitHub()
    const refused = await failure(Statuses.create("o", "../r", HEAD, { state: "success", context: "smithers/lint" }))
    expect(refused.reason).toBe("invalid-config")
    expect(github!.fixture.requests).toHaveLength(0)
  })
})
