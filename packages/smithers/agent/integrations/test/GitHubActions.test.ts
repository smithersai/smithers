/**
 * The GitHub write-back actions, executed through the real flow runtime
 * against a stateful fake GitHub on a real socket.
 *
 * Each case runs one action as the body of a flow on `FlowEngine.layerMemory`,
 * so the payload decodes, the idempotency key is computed, the engine's retry
 * policy applies and the result crosses the journal's schema. The recovery
 * cases are the reason the actions exist: a write GitHub applied but whose
 * answer was lost is repeated, and the repeat finds its own work.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, type Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import { afterEach, describe, expect, it } from "vitest"
import { IntegrationFailure, RetryableIntegrationFailure } from "../src/core/ActionFailure.vibe"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import * as Actions from "../src/github/Actions.vibe"
import type * as GitHubClient from "../src/github/GitHubClient.vibe"
import { type FakeGitHub, startGitHub } from "./GitHubFake.ts"
import { type Fault, faultingTransport, fetchLayer, gitHubLayer, gitHubLayerOver } from "./Http.ts"

let github: FakeGitHub | undefined

afterEach(async () => {
  await github?.fixture.close()
  github = undefined
})

type GitHubTag = Layer.Success<typeof Actions.layer> extends Action.Requirement<infer Tag> ? Tag : never
type PureSchema = { readonly DecodingServices: never; readonly EncodingServices: never }

const runAction = <
  Tag extends GitHubTag,
  Payload extends Flow.AnyStructSchema & PureSchema,
  Success extends Schema.Top & PureSchema,
  Error extends Schema.Top & PureSchema
>(
  declaration: Action.Declared<Tag, Payload, Success, Error>,
  payload: Payload["~type.make.in"],
  clientLayer: Layer.Layer<GitHubClient.GitHubClient, IntegrationError> = gitHubLayer({
    token: "t",
    apiBaseUrl: (github as FakeGitHub).fixture.origin
  }, {})
): Promise<Success["Type"]> => {
  const flow = Flow.make(`${declaration.name}/test-flow`, {
    payload: declaration.payloadSchema,
    success: declaration.successSchema,
    error: declaration.errorSchema,
    // The cast is on the payload value only (decoded Type vs planned make-in); R is untouched.
    body: (input) => declaration.call(input as never)
  })
  const implementation = Actions.layer as Layer.Layer<
    Action.Requirement<Tag>,
    never,
    Layer.Services<typeof Actions.layer>
  >
  const layer = Layer.mergeAll(implementation, Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, clientLayer, NodeCrypto.layer))
  )
  return Effect.runPromise(
    flow.execute(payload, { executionId: `run-${declaration.name}-${Math.random()}` }).pipe(
      Effect.provide(layer),
      Effect.scoped
    )
  )
}

/**
 * Runs `flow` as `executionId` over every GitHub action's implementation, as `runAction` does, so a case can make
 * several writes in one run or name the run.
 */
const runFlow = <Name extends string, P extends Flow.AnyStructSchema, S extends Schema.Top, E extends Schema.Top, R>(
  flow: Flow.Flow<Name, P, S, E, R>,
  payload: P["Type"],
  executionId: string
): Promise<S["Type"]> => {
  const layer = Layer.mergeAll(Actions.layer, Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(
      Layer.mergeAll(
        FlowEngine.layerMemory,
        gitHubLayer({ token: "t", apiBaseUrl: (github as FakeGitHub).fixture.origin }, {}),
        NodeCrypto.layer
      )
    )
  )
  return Effect.runPromise(
    (flow.execute(payload, { executionId }) as Effect.Effect<S["Type"], unknown, never>).pipe(
      Effect.provide(layer as unknown as Layer.Layer<never>),
      Effect.scoped
    )
  )
}

/** The key a write without one gets in execution `executionId`: `run:` and 32 hex of SHA-256 over the run. */
const runKeyOf = async (executionId: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`smithers/run-key/v1\n${executionId}`)
  )
  return `run:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)}`
}

const rejected = async (promise: Promise<unknown>): Promise<any> => {
  const failure: any = await promise.then(() => undefined, (error: unknown) => error)
  return failure?.cause?.error ?? failure?.error ?? failure
}

const SHA = "a".repeat(40)

describe("reconciliation decoding", () => {
  it.each(["labels", "comments", "check-runs"] as const)("refuses undecodable %s before writing", async (kind) => {
    github = await startGitHub()
    const { transport } = faultingTransport(({ method }) =>
      method === "GET"
        ? {
          status: 200,
          body: kind === "check-runs"
            ? { total_count: 1, check_runs: [{ id: "bad", external_id: "run-1", app: { id: 42 } }] }
            : kind === "comments"
            ? [{
              id: "bad",
              url: "u",
              body: "<!-- smithers:key=run-1 -->\nWorking",
              user: { login: "smithers", type: "Bot" }
            }]
            : [{ name: 7 }]
        }
        : undefined
    )
    const client = gitHubLayerOver(transport, { token: "t", apiBaseUrl: github.fixture.origin })
    const failure = await rejected(
      kind === "labels"
        ? runAction(Actions.AddLabels, { owner: "o", repo: "r", issueNumber: 7, labels: ["triage"] }, client)
        : kind === "comments"
        ? runAction(Actions.UpsertComment, {
          owner: "o",
          repo: "r",
          issueNumber: 7,
          key: "run-1",
          body: "Working",
          author: { login: "smithers" }
        }, client)
        : runAction(Actions.CheckRun, {
          owner: "o",
          repo: "r",
          appId: 42,
          headSha: SHA,
          name: "smithers",
          key: "run-1"
        }, client)
    )
    expect(github.writes()).toEqual([])
    expect(failure).toBeInstanceOf(IntegrationFailure)
    expect(failure).toMatchObject({ reason: "decode-failed", retryable: false })
  })
})

describe("AddLabels", () => {
  it("adds only the labels the issue lacks, comparing names without case", async () => {
    github = await startGitHub()
    github.labels = ["Bug"]
    const added = await runAction(Actions.AddLabels, {
      owner: "o",
      repo: "r",
      issueNumber: 7,
      labels: ["bug", "triage", "triage"]
    })
    expect(added).toEqual({ added: ["triage"], labels: ["Bug", "triage"] })
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/labels"])
    expect(JSON.parse(github.fixture.requests[1]?.body ?? "{}")).toEqual({ labels: ["triage"] })
  })

  it("writes nothing when every label is already there", async () => {
    github = await startGitHub()
    github.labels = ["bug"]
    const added = await runAction(Actions.AddLabels, { owner: "o", repo: "r", issueNumber: 7, labels: ["BUG"] })
    expect(added).toEqual({ added: [], labels: ["bug"] })
    expect(github.writes()).toEqual([])
  })

  it("repeats a POST whose answer was lost, and the repeat finds the labels", async () => {
    github = await startGitHub()
    github.lose = true
    const added = await runAction(Actions.AddLabels, { owner: "o", repo: "r", issueNumber: 7, labels: ["triage"] })
    expect(added).toEqual({ added: [], labels: ["triage"] })
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/labels"])
    expect(github.labels).toEqual(["triage"])
  })

  it("keys the step by what it adds", () => {
    const key = Actions.AddLabels.idempotencyKey as (payload: unknown) => unknown
    expect(key({ owner: "o", repo: "r", issueNumber: 7, labels: ["a"] })).toEqual({
      action: "integrations/github/add-labels",
      owner: "o",
      repo: "r",
      issueNumber: 7,
      labels: ["a"]
    })
    expect(Actions.AddLabels.tier).toBe("irreversible")
    expect(Actions.retryPolicy.maxAttempts).toBe(3)
  })
})

// The engine's retry policy is the only retry a write gets. These cases inject
// a provider refusal at an exact request through the client's `HttpClient`
// and count every request the client made, so a retry hidden in the client
// would show up as an extra one.
describe("the engine is the only retry", () => {
  const labels = { owner: "o", repo: "r", issueNumber: 7, labels: ["triage"] as const }

  /** A client over a transport that answers the POSTs `fault` picks in place of GitHub. */
  const faulting = (fault: (post: number) => Fault | undefined) => {
    let posts = 0
    const { transport, handled } = faultingTransport(({ method }) => method === "POST" ? fault(++posts) : undefined)
    return {
      handled,
      client: gitHubLayerOver(transport, { token: "t", apiBaseUrl: (github as FakeGitHub).fixture.origin })
    }
  }

  it("waits the Retry-After a rate-limited write named, then writes once", async () => {
    github = await startGitHub()
    // The asked-for wait is past the policy's 500 ms first backoff, so only an
    // engine that read the failure's retryAfterMillis produces this gap.
    const { handled, client } = faulting((post) =>
      post === 1 ? { status: 429, headers: { "retry-after": "1" }, body: { message: "rate limited" } } : undefined
    )
    const added = await runAction(Actions.AddLabels, labels, client)
    expect(added).toEqual({ added: ["triage"], labels: ["triage"] })
    expect(handled.map((request) => `${request.method} ${request.faulted ?? "sent"}`)).toEqual([
      "GET sent",
      "POST 429",
      "GET sent",
      "POST sent"
    ])
    expect(handled[3]!.at - handled[1]!.at).toBeGreaterThanOrEqual(1_000)
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/labels"])
  })

  // A client that retried a rate limit itself, inside each of the engine's
  // attempts, made one write up to twelve requests.
  it("makes at most the policy's attempts at a write that stays rate limited, not a client budget per attempt", async () => {
    github = await startGitHub()
    const { handled, client } = faulting(() => ({
      status: 429,
      headers: { "retry-after": "0" },
      body: { message: "rate limited" }
    }))
    const failure = await rejected(runAction(Actions.AddLabels, labels, client))
    expect(failure).toBeInstanceOf(RetryableIntegrationFailure)
    expect(failure).toMatchObject({ retryable: true, retryAfterMillis: 0 })
    expect(handled.filter((request) => request.method === "POST")).toHaveLength(Actions.retryPolicy.maxAttempts!)
    expect(github.writes()).toEqual([])
  })

  it("reports a refusal another attempt cannot clear at once", async () => {
    github = await startGitHub()
    const { handled, client } = faulting(() => ({ status: 422, body: { message: "Validation Failed" } }))
    const failure = await rejected(runAction(Actions.AddLabels, labels, client))
    expect(failure).toBeInstanceOf(IntegrationFailure)
    expect(failure).toMatchObject({ retryable: false })
    expect(handled.map((request) => request.method)).toEqual(["GET", "POST"])
  })

  it("never repeats a comment, and hands a rate limit's wait to the flow", async () => {
    github = await startGitHub()
    const { handled, client } = faulting(() => ({
      status: 429,
      headers: { "retry-after": "1" },
      body: { message: "rate limited" }
    }))
    const failure = await rejected(
      runAction(Actions.CommentOnIssue, { owner: "o", repo: "r", issueNumber: 7, body: "hi" }, client)
    )
    expect(failure).toBeInstanceOf(RetryableIntegrationFailure)
    expect(failure).toMatchObject({ retryable: true, retryAfterMillis: 1_000 })
    expect(handled).toHaveLength(1)
  })
})

describe("UpsertComment", () => {
  const payload = {
    owner: "o",
    repo: "r",
    issueNumber: 7,
    key: "run-1",
    body: "Working",
    author: { login: "smithers" }
  }

  it("does not adopt a stranger's marker", async () => {
    github = await startGitHub()
    github.comments.push({
      id: 5,
      url: "u5",
      body: "<!-- smithers:key=run-1 -->\nForged",
      user: { login: "stranger", type: "User" }
    })
    const result = await runAction(Actions.UpsertComment, payload)
    expect(result.outcome).toBe("created")
    expect(github.comments[0]?.body).toContain("Forged")
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/comments"])
  })

  it("adopts only Bot comments attributed to the configured App", async () => {
    github = await startGitHub()
    const body = "<!-- smithers:key=run-1 -->\nForged"
    github.comments.push(
      { id: 5, url: "u5", body, user: { login: "stranger", type: "User" }, performed_via_github_app: { id: 42 } },
      { id: 6, url: "u6", body, user: { login: "other[bot]", type: "Bot" }, performed_via_github_app: { id: 43 } },
      { id: 7, url: "u7", body, user: { login: "smithers", type: "Bot" }, performed_via_github_app: { id: 42 } }
    )
    const result = await runAction(Actions.UpsertComment, { ...payload, author: { appId: 42 } })
    expect(result).toMatchObject({ outcome: "updated", id: 7 })
    expect(github.comments.slice(0, 2).map((comment) => comment.body)).toEqual([body, body])
    expect(github.writes()).toEqual(["PATCH /repos/o/r/issues/comments/7"])
  })

  it("ignores marked comments with missing or null attribution", async () => {
    github = await startGitHub()
    github.comments.push({ id: 5, url: "u5", body: "<!-- smithers:key=run-1 -->\nForged" })
    const result = await runAction(Actions.UpsertComment, payload)
    expect(result.outcome).toBe("created")
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/comments"])
  })

  it("posts the comment under its hidden key", async () => {
    github = await startGitHub()
    const sticky = await runAction(Actions.UpsertComment, payload)
    expect(sticky).toMatchObject({ outcome: "created", id: 100 })
    expect(github.comments.map((comment) => comment.body)).toEqual(["<!-- smithers:key=run-1 -->\nWorking"])
  })

  it("edits the same comment on the next upsert, and leaves it when unchanged", async () => {
    github = await startGitHub()
    await runAction(Actions.UpsertComment, payload)
    const updated = await runAction(Actions.UpsertComment, { ...payload, body: "Done" })
    expect(updated).toMatchObject({ outcome: "updated", id: 100 })
    const unchanged = await runAction(Actions.UpsertComment, { ...payload, body: "Done" })
    expect(unchanged).toEqual({ id: 100, url: github.comments[0]?.url, outcome: "unchanged" })
    expect(github.comments).toHaveLength(1)
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/comments", "PATCH /repos/o/r/issues/comments/100"])
  })

  it("keeps separate comments for separate keys, and ignores a key quoted mid-comment", async () => {
    github = await startGitHub()
    github.comments.push({ id: 5, url: "u5", body: "see <!-- smithers:key=run-1 -->" })
    await runAction(Actions.UpsertComment, payload)
    await runAction(Actions.UpsertComment, { ...payload, key: "run-2" })
    expect(github.comments).toHaveLength(3)
    expect(github.comments[0]?.body).toBe("see <!-- smithers:key=run-1 -->")
  })

  it("finds its comment after someone edits it on github.com, which stores CRLF line ends", async () => {
    github = await startGitHub()
    github.comments.push({
      id: 5,
      url: "u5",
      body: "<!-- smithers:key=run-1 -->\r\nWorking, edited by hand",
      user: { login: "SMITHERS", type: "User" }
    })
    const sticky = await runAction(Actions.UpsertComment, payload)
    expect(sticky).toMatchObject({ outcome: "updated", id: 5 })
    expect(github.comments).toHaveLength(1)
    expect(github.writes()).toEqual(["PATCH /repos/o/r/issues/comments/5"])
  })

  it("replays a lost POST as a find of the same sticky comment", async () => {
    github = await startGitHub()
    github.lose = true
    const sticky = await runAction(Actions.UpsertComment, payload)
    expect(sticky.outcome).toBe("unchanged")
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/comments"])
    expect(github.comments).toHaveLength(1)
  })

  it("refuses to post when the thread is longer than it will search", async () => {
    github = await startGitHub()
    github.endlessComments = true
    const failure = await rejected(runAction(Actions.UpsertComment, payload))
    expect(failure).toBeInstanceOf(IntegrationFailure)
    expect(failure.message).toContain("more comments than 10 pages")
    expect(github.writes()).toEqual([])
  })

  it("refuses a key that could break out of the marker", async () => {
    github = await startGitHub()
    const failure = await rejected(runAction(Actions.UpsertComment, { ...payload, key: "a -->" }))
    expect(failure).toBeDefined()
    expect(github.fixture.requests).toHaveLength(0)
  })
})

describe("UpsertComment and CheckRun without a key", () => {
  const comment = { owner: "o", repo: "r", issueNumber: 7, body: "Working", author: { login: "smithers" } }
  const check = { owner: "o", repo: "r", appId: 42, headSha: SHA, name: "smithers", status: "in_progress" as const }

  /** One run that upserts its comment twice and reports its check run twice, from two steps each. */
  const Progress = Flow.make("integrations/github/test-progress", {
    payload: Actions.UpsertCommentPayload,
    success: Actions.CheckRunReceipt,
    error: Actions.UpsertComment.errorSchema,
    body: () =>
      Actions.UpsertComment.call(comment).pipe(
        Node.andThen(Actions.UpsertComment.call({ ...comment, body: "Done" })),
        Node.andThen(Actions.CheckRun.call(check)),
        Node.andThen(Actions.CheckRun.call({ ...check, status: "completed", conclusion: "success" }))
      )
  })

  it("keeps one comment and one check run per run, keyed by the run and never naming it", async () => {
    github = await startGitHub()
    const done = await runFlow(Progress, comment, "run-a")
    expect(done).toMatchObject({ created: false, status: "completed" })
    const key = await runKeyOf("run-a")
    expect(key).toMatch(/^run:[0-9a-f]{32}$/)
    expect(github.comments.map((each) => each.body)).toEqual([`<!-- smithers:key=${key} -->\nDone`])
    expect(github.checkRuns.map((run) => [run.external_id, run.status])).toEqual([[key, "completed"]])
    expect(JSON.stringify(github.fixture.requests)).not.toContain("run-a")
    expect(github.writes()).toEqual([
      "POST /repos/o/r/issues/7/comments",
      "PATCH /repos/o/r/issues/comments/100",
      "POST /repos/o/r/check-runs",
      "PATCH /repos/o/r/check-runs/101"
    ])

    // Another run never takes over the first run's comment or check run.
    await runFlow(Progress, comment, "run-b")
    const other = await runKeyOf("run-b")
    expect(other).not.toBe(key)
    expect(github.comments.map((each) => each.body)).toEqual([
      `<!-- smithers:key=${key} -->\nDone`,
      `<!-- smithers:key=${other} -->\nDone`
    ])
    expect(github.checkRuns.map((run) => run.external_id)).toEqual([key, other])
  })

  it("leaves the idempotency key's slot for the key null, as canonical JSON needs", () => {
    const keyOf = Actions.UpsertComment.idempotencyKey as (payload: unknown) => Record<string, unknown>
    expect(keyOf(comment)).toMatchObject({ key: null })
    expect(keyOf({ ...comment, key: "dashboard" })).toMatchObject({ key: "dashboard" })
  })

  it("has no key to give outside a flow execution: it dies rather than write under no one's", async () => {
    const exit = await Effect.runPromise(Effect.exit(Actions.runKey(Actions.UpsertComment.name)))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
      _tag: "@smthrs/flow/EffectKeyUnavailable",
      name: "integrations/github/upsert-comment"
    })
  })
})

describe("CheckRun", () => {
  const payload = {
    owner: "o",
    repo: "r",
    appId: 42,
    headSha: SHA,
    name: "smithers",
    key: "run-1",
    status: "in_progress" as const
  }

  it("does not adopt another App's check run with the same external id", async () => {
    github = await startGitHub()
    github.checkRuns.push({
      id: 5,
      name: "smithers",
      head_sha: SHA,
      external_id: "run-1",
      html_url: "u5",
      status: "queued",
      conclusion: null,
      app: { id: 43 }
    })
    const receipt = await runAction(Actions.CheckRun, payload)
    expect(receipt.created).toBe(true)
    expect(github.checkRuns[0]?.status).toBe("queued")
    expect(github.writes()).toEqual(["POST /repos/o/r/check-runs"])
  })

  it("creates the check run under its external id", async () => {
    github = await startGitHub()
    const receipt = await runAction(Actions.CheckRun, {
      ...payload,
      detailsUrl: "https://smithers.test/runs/1",
      output: { title: "Running", summary: "1 of 3" }
    })
    expect(receipt).toEqual({
      id: 100,
      url: "https://github.test/o/r/runs/101",
      status: "in_progress",
      conclusion: null,
      created: true
    })
    const sent = JSON.parse(github.fixture.requests[1]?.body ?? "{}")
    expect(sent).toEqual({
      name: "smithers",
      external_id: "run-1",
      status: "in_progress",
      details_url: "https://smithers.test/runs/1",
      output: { title: "Running", summary: "1 of 3" },
      head_sha: SHA
    })
    const listing = new URL(github.fixture.requests[0]?.url ?? "", "http://x")
    expect(listing.pathname).toBe(`/repos/o/r/commits/${SHA}/check-runs`)
    expect(Object.fromEntries(listing.searchParams)).toEqual({
      check_name: "smithers",
      filter: "all",
      per_page: "100"
    })
  })

  it("updates the same run to its conclusion", async () => {
    github = await startGitHub()
    await runAction(Actions.CheckRun, { ...payload, status: "queued" })
    const done = await runAction(Actions.CheckRun, { ...payload, status: "completed", conclusion: "success" })
    expect(done).toMatchObject({ id: 100, status: "completed", conclusion: "success", created: false })
    expect(github.checkRuns).toHaveLength(1)
    expect(github.writes()).toEqual(["POST /repos/o/r/check-runs", "PATCH /repos/o/r/check-runs/100"])
    expect(JSON.parse(github.fixture.requests[3]?.body ?? "{}")).toEqual({
      name: "smithers",
      external_id: "run-1",
      status: "completed",
      conclusion: "success"
    })
  })

  it("repeats a lost create as an update of the run it made", async () => {
    github = await startGitHub()
    github.lose = true
    const receipt = await runAction(Actions.CheckRun, {
      owner: "o",
      repo: "r",
      appId: 42,
      headSha: SHA,
      name: "smithers",
      key: "k"
    })
    expect(receipt.created).toBe(false)
    expect(github.checkRuns).toHaveLength(1)
  })

  it("refuses to create when the listing is incomplete", async () => {
    github = await startGitHub()
    github.truncatedCheckRuns = true
    const failure = await rejected(runAction(Actions.CheckRun, payload))
    expect(failure.message).toContain("more than 100 \"smithers\" check runs")
    expect(github.writes()).toEqual([])
  })

  it("refuses a SHA that is not one", async () => {
    github = await startGitHub()
    await expect(runAction(Actions.CheckRun, { ...payload, headSha: "../x" })).rejects.toBeDefined()
    expect(github.fixture.requests).toHaveLength(0)
  })
})

describe("LinkPullRequest", () => {
  const payload = { owner: "o", repo: "r", pullNumber: 9, issueNumber: 7 }
  it.each([1, 2])("honors an HTTP 200 GraphQL rate limit on POST %i before retrying the step", async (limitedPost) => {
    github = await startGitHub()
    let posts = 0
    const { transport, handled } = faultingTransport(({ path }) =>
      path === "/graphql" && ++posts === limitedPost
        ? { status: 200, headers: { "retry-after": "1" }, body: { errors: [{ type: "RATE_LIMITED" }] } }
        : undefined
    )
    const result = await runAction(
      Actions.LinkPullRequest,
      payload,
      gitHubLayerOver(transport, { token: "t", apiBaseUrl: github.fixture.origin })
    )
    expect(result.updated).toBe(true)
    const fault = handled.findIndex((request) => request.faulted === 200)
    expect(handled[fault + 1]!.at - handled[fault]!.at).toBeGreaterThanOrEqual(1_000)
    expect([...github.linkedIssues]).toEqual(["o/r#7"])
    expect(github.writes()).toEqual(["POST /graphql"])
  })

  it.each(["`Closes #7`", "```\nFixes #7\n```", "<!-- Resolves #7 -->", "    Closes #7"])(
    "checks actual closing references for Markdown %s",
    async (body) => {
      github = await startGitHub()
      github.pullBody = body
      const result = await runAction(Actions.LinkPullRequest, payload)
      expect(result.updated).toBe(true)
      expect([...github.linkedIssues]).toEqual(["o/r#7"])
      expect(github.pullBody).toBe(body)
    }
  )

  const targets = {
    data: {
      pullRepository: {
        pullRequest: {
          id: "pull-9",
          closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } }
        }
      },
      issueRepository: { issue: { id: "o/r#7" } }
    }
  }

  it.each([
    ["query errors", { ...targets, errors: [{ message: "private provider content" }] }],
    ["an incomplete reference list", {
      data: {
        ...targets.data,
        pullRepository: {
          pullRequest: {
            id: "pull-9",
            closingIssuesReferences: {
              nodes: [],
              pageInfo: { hasNextPage: true }
            }
          }
        }
      }
    }],
    ["an inaccessible repository", { data: { ...targets.data, pullRepository: null } }]
  ])("refuses %s without a mutation or a body edit", async (_name, body) => {
    github = await startGitHub()
    github.pullBody = "Keep this description"
    const { transport } = faultingTransport(({ path }) => path === "/graphql" ? { status: 200, body } : undefined)
    const error = await rejected(
      runAction(
        Actions.LinkPullRequest,
        payload,
        gitHubLayerOver(transport, { token: "t", apiBaseUrl: github.fixture.origin })
      )
    )
    expect(error).toBeInstanceOf(IntegrationFailure)
    expect(error.retryable).toBe(false)
    expect(error.message).not.toContain("private provider content")
    expect(github.writes()).toEqual([])
    expect(github.pullBody).toBe("Keep this description")
  })

  it.each([
    ["a missing receipt", { data: null }],
    ["mutation errors", { data: { addCloseIssueReferences: { issue: { id: "o/r#7" } } }, errors: [{}] }],
    ["the wrong issue", { data: { addCloseIssueReferences: { issue: { id: "o/r#8" } } }, errors: [] }]
  ])("reports an unknown outcome for %s", async (_name, body) => {
    github = await startGitHub()
    let posts = 0
    const { transport, handled } = faultingTransport(({ path }) =>
      path === "/graphql" && ++posts % 2 === 0 ? { status: 200, body } : undefined
    )
    const error = await rejected(
      runAction(
        Actions.LinkPullRequest,
        payload,
        gitHubLayerOver(transport, { token: "t", apiBaseUrl: github.fixture.origin })
      )
    )
    expect(error).toBeInstanceOf(RetryableIntegrationFailure)
    expect(error).toMatchObject({ reason: "decode-failed", outcomeUnknown: true })
    expect(handled.filter((request) => request.faulted !== undefined)).toHaveLength(Actions.retryPolicy.maxAttempts!)
    expect(github.writes()).toEqual([])
  })

  it("leaves an existing manual closing reference alone", async () => {
    github = await startGitHub()
    github.linkedIssues.add("o/r#7")
    const result = await runAction(Actions.LinkPullRequest, payload)
    expect(result.updated).toBe(false)
    expect(github.writes()).toEqual([])
    expect(github.pullBody).toBeNull()
  })

  it("preserves description edits made after the initial read", async () => {
    github = await startGitHub()
    github.pullBody = "Initial description"
    const real = Effect.runSync(Effect.provide(Effect.service(HttpClient.HttpClient), fetchLayer))
    const transport = HttpClient.make((request) =>
      real.execute(request).pipe(Effect.tap(() =>
        Effect.sync(() => {
          if (request.method === "GET" && new URL(request.url).pathname === "/repos/o/r/pulls/9") {
            github!.pullBody = "Edited while linking"
          }
        })
      ))
    )
    await runAction(
      Actions.LinkPullRequest,
      { owner: "o", repo: "r", pullNumber: 9, issueNumber: 7 },
      gitHubLayerOver(transport, { token: "t", apiBaseUrl: github.fixture.origin })
    )
    expect(github.pullBody).toBe("Edited while linking")
  })

  it("adds a closing reference without changing an empty description", async () => {
    github = await startGitHub()
    const linked = await runAction(Actions.LinkPullRequest, { owner: "o", repo: "r", pullNumber: 9, issueNumber: 7 })
    expect(linked).toEqual({ pullNumber: 9, url: "https://github.test/o/r/pull/9", reference: "#7", updated: true })
    expect(github.pullBody).toBeNull()
    expect([...github.linkedIssues]).toEqual(["o/r#7"])
  })

  it("links a cross-repository issue without changing the description", async () => {
    github = await startGitHub()
    github.pullBody = "Fixes the parser."
    const linked = await runAction(Actions.LinkPullRequest, {
      owner: "o",
      repo: "r",
      pullNumber: 9,
      issueNumber: 7,
      issueOwner: "other",
      issueRepo: "tracker.js"
    })
    expect(linked.reference).toBe("other/tracker.js#7")
    expect(github.pullBody).toBe("Fixes the parser.")
    expect([...github.linkedIssues]).toEqual(["other/tracker.js#7"])
  })

  it("leaves a description that already closes the issue", async () => {
    github = await startGitHub()
    github.pullBody = "resolved: O/R#7"
    github.linkedIssues.add("o/r#7")
    const linked = await runAction(Actions.LinkPullRequest, {
      owner: "o",
      repo: "r",
      pullNumber: 9,
      issueNumber: 7,
      issueOwner: "o",
      issueRepo: "r"
    })
    expect(linked).toMatchObject({ reference: "#7", updated: false })
    expect(github.writes()).toEqual([])
  })

  it("repeats a lost edit and finds the reference it added", async () => {
    github = await startGitHub()
    github.lose = true
    const linked = await runAction(Actions.LinkPullRequest, { owner: "o", repo: "r", pullNumber: 9, issueNumber: 7 })
    expect(linked.updated).toBe(false)
    expect(github.pullBody).toBeNull()
    expect([...github.linkedIssues]).toEqual(["o/r#7"])
    expect(github.writes()).toEqual(["POST /graphql"])
  })

  it("refuses an issue repository that is not a name", async () => {
    github = await startGitHub()
    const failure = await rejected(
      runAction(Actions.LinkPullRequest, { owner: "o", repo: "r", pullNumber: 9, issueNumber: 7, issueRepo: ".." })
    )
    expect(failure).toBeDefined()
    expect(github.fixture.requests).toHaveLength(0)
  })
})

describe("concurrent keyed writes", () => {
  it("creates one sticky comment for concurrent upserts of the same key", async () => {
    github = await startGitHub()
    const client = gitHubLayer({ token: "t", apiBaseUrl: github.fixture.origin }, {})
    const receipts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      runAction(Actions.UpsertComment, {
        owner: "o",
        repo: "r",
        issueNumber: 7,
        key: "shared",
        body: `Update ${index}`,
        author: { login: "smithers" }
      }, client)))
    expect(github.comments).toHaveLength(1)
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(1)
  })

  it("creates one check run for concurrent calls with the same external key", async () => {
    github = await startGitHub()
    const client = gitHubLayer({ token: "t", apiBaseUrl: github.fixture.origin }, {})
    const receipts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      runAction(Actions.CheckRun, {
        owner: "o",
        repo: "r",
        appId: 42,
        headSha: SHA,
        name: "smithers",
        key: "shared",
        output: { title: "Progress", summary: `Update ${index}` }
      }, client)))
    expect(github.checkRuns).toHaveLength(1)
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(1)
  })
})
