// The sandbox tools' routes (worker/branch/SandboxCalls.ts, docs/features/sandbox-tools.md#the-routes) through the
// branch workspace's real routes (worker/test/branch.ts), on this file's schema of the compose Postgres (`pnpm db:up`).
// Remote flow starts are recorded by the harness's `FlowStarter`; `sandbox/Call` itself runs in
// worker/flows/SandboxCall.test.ts, so a call's row is settled here with that flow's own `settle`.
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import {
  callExecutionId,
  COMMAND_LIMIT_SECONDS,
  MAX_CALL_BODY_BYTES,
  SANDBOX_CALLS_ROUTE,
} from "../../src/features/sandbox/contract.ts"
import { type Actor, Sessions, SessionsUnavailable } from "../Actor.ts"
import * as Flows from "../Flows.ts"
import { settle } from "../flows/SandboxCall.ts"
import * as Messages from "../Messages.ts"
import { branchHarness, type BranchHarness, resetBranches, shared, tracked } from "../test/branch.ts"
import { recorded, testFile } from "../test/harness.ts"
import { BranchRoles } from "./Access.ts"
import * as BranchApi from "./BranchApi.ts"
import * as Conversations from "./Conversations.ts"
import * as SandboxCalls from "./SandboxCalls.ts"

const runtime = testFile("sandbox_calls")
beforeEach(() => resetBranches(runtime))

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member", login: "mona" }
const other: Actor = { subject: { kind: "person", id: "person-other" }, role: "maintainer" }
const guest: Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest" }

const REPO = "github/octocat/spoon-knife"

/** A command no record may carry: content, like everything a tool reads or runs. */
const SENTINEL = "sentinel-3c9e1d"

const open = (actor: Actor | null = member, options: Parameters<typeof branchHarness>[1] = {}) =>
  branchHarness(runtime, { ...(actor === null ? {} : { actor }), ...options })

const json = async (response: Response) => [response.status, await response.json()]

const post = (h: BranchHarness, body: unknown) =>
  h.fetch(SANDBOX_CALLS_ROUTE, {
    method: "POST",
    body: (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit,
  })

const get = (h: BranchHarness, callId: string, method = "GET") => h.fetch(`${SANDBOX_CALLS_ROUTE}/${callId}`, { method })

const run = { tool: "run", command: `echo ${SENTINEL}` } as const

/** Every call Postgres holds, oldest first. */
const calls = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      readonly id: string
      readonly branchId: string
      readonly personId: string
      readonly answerId: string | null
      readonly tool: string
      readonly status: string
    }>`
      SELECT id, branch_id AS "branchId", person_id AS "personId", answer_id AS "answerId", tool, status
      FROM sandbox_calls ORDER BY created_at, id`))

/** Asks a question in `conversationId` as `askedBy`: its answer's id. */
const asked = async (conversationId: string, askedBy: string) => {
  const ids = { id: crypto.randomUUID(), answerId: crypto.randomUUID() }
  await runtime.runPromise(Messages.ask({ ...ids, conversationId, text: "Run the tests", askedBy }))
  return ids
}

describe("POST /api/sandbox/calls", () => {
  test.each([null, "guest"] as const)("a repository Member with deployment role %s cannot launch a sandbox tool as a person or agent", async role => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const answer = await asked(branch.conversationId, member.subject.id)
    for (const agent of [false, true]) {
      const actor = { ...member, role, ...(agent ? { act: { kind: "agent" as const, id: answer.answerId } } : {}) }
      const h = await open(actor, { branchRoles: Layer.succeed(BranchRoles, { roleOn: () => Effect.succeed("member"), uninstalled: () => "member" }) })
      const response = await post(h, { callId: crypto.randomUUID(), call: run, ...(agent ? { answerId: answer.answerId } : { conversationId: branch.conversationId }) })
      expect(await json(response)).toEqual([403, { code: "members_only", message: "Members can run machines." }])
      expect(h.starts).toEqual([])
      expect(h.only("sandbox.call").annotations).toMatchObject({ status: 403, code: "members_only" })
    }
    expect(await calls()).toEqual([])
  })

  test("a person's call on a branch they may edit is 202, recorded running and started as sandbox/Call", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const h = await open()
    const callId = crypto.randomUUID()

    const response = await post(h, { callId: callId.toUpperCase(), call: run, conversationId: branch.conversationId.toUpperCase() })

    expect(await json(response)).toEqual([202, { callId, status: "running" }])
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await calls()).toEqual([
      { id: callId, branchId: branch.branchId, personId: "person-member", answerId: null, tool: "run", status: "running" },
    ])
    expect(h.starts).toEqual([{
      flow: "sandbox/Call",
      executionId: callExecutionId(callId),
      payload: {
        callId,
        ownerId: "person-member",
        branch: { branchId: branch.branchId, owner: "octocat", name: "spoon-knife", branch: "feature/x" },
        call: run,
      },
    }])
    expect(h.only("sandbox.call")).toMatchObject({
      level: "INFO",
      annotations: {
        callId,
        tool: "run",
        door: "person",
        branchId: branch.branchId,
        outcome: "running",
        status: 202,
        durationMs: expect.any(Number),
      },
    })
    expect(h.count(SandboxCalls.requests, { route: "call", outcome: "running" })).toBe(1)
    expect(h.span("sandbox.call")).toHaveLength(1)
    // Ids, the tool and outcomes only: never the command, the branch's name or the person's login.
    expect(recorded(h)).not.toContain(SENTINEL)
    expect(recorded(h)).not.toContain("feature/x")
    expect(recorded(h)).not.toContain("mona")
  })

  test("a command runs up to the deployment's SANDBOX_COMMAND_MAX_SECONDS; one past it is too_long with the limit", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const target = { conversationId: branch.conversationId }
    const long = (timeoutSeconds: number) => ({ ...run, timeoutSeconds })
    const hour = await open()
    for (const timeoutSeconds of [1200, COMMAND_LIMIT_SECONDS]) {
      const callId = crypto.randomUUID()
      expect(await json(await post(hour, { callId, call: long(timeoutSeconds), ...target }))).toEqual([
        202,
        { callId, status: "running" },
      ])
      expect(hour.starts.at(-1)!.payload).toMatchObject({ call: long(timeoutSeconds) })
    }
    expect(await json(await post(hour, { callId: crypto.randomUUID(), call: long(COMMAND_LIMIT_SECONDS + 1), ...target })))
      .toEqual([400, { code: "invalid" }])

    const quarter = await open(member, { config: { SANDBOX_COMMAND_MAX_SECONDS: "900" } })
    const callId = crypto.randomUUID()
    expect(await json(await post(quarter, { callId, call: long(900), ...target }))).toEqual([202, { callId, status: "running" }])
    const refused = await post(quarter, { callId: crypto.randomUUID(), call: long(901), ...target })
    expect(await json(refused)).toEqual([
      400,
      { code: "too_long", maxSeconds: 900 },
    ])
    expect(refused.headers.get("cache-control")).toBe("no-store")
    expect(quarter.starts).toHaveLength(1)
    expect(await calls()).toHaveLength(3)
    expect(quarter.line("sandbox.call").at(-1)).toMatchObject({
      level: "WARN",
      annotations: { code: "too_long", outcome: "too_long", status: 400 },
    })
    expect(quarter.count(SandboxCalls.requests, { route: "call", outcome: "too_long" })).toBe(1)
    expect(recorded(quarter)).not.toContain(SENTINEL)
    expect(await json(await post(quarter, { callId: crypto.randomUUID(), call: long(COMMAND_LIMIT_SECONDS + 1), ...target })))
      .toEqual([400, { code: "invalid" }])
    expect(quarter.starts).toHaveLength(1)
    expect(await calls()).toHaveLength(3)
  })

  test("a deployment whose SANDBOX_COMMAND_MAX_SECONDS isn't whole seconds from 60 to an hour doesn't start", async () => {
    for (const invalid of ["59", "3601", "an hour"]) {
      await expect(open(member, { config: { SANDBOX_COMMAND_MAX_SECONDS: invalid } }), invalid).rejects.toThrow()
    }
  })

  test("a resend is 200 as the call stands: running starts the same execution again; settled starts nothing", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const h = await open()
    const body = { callId: crypto.randomUUID(), call: run, conversationId: branch.conversationId }

    expect((await post(h, body)).status).toBe(202)
    expect(await json(await post(h, body))).toEqual([200, { callId: body.callId, status: "running" }])
    expect(h.starts.map((start) => start.executionId)).toEqual([
      callExecutionId(body.callId),
      callExecutionId(body.callId),
    ])

    const result = {
      tool: "run",
      exitCode: 0,
      timedOut: false,
      stdout: "ok\n",
      stderr: "",
      stdoutBytes: 3,
      stderrBytes: 0,
      truncated: false,
    } as const
    await runtime.runPromise(settle(body.callId, { status: "done", result, generation: 2 }))
    expect(await json(await post(h, body))).toEqual([200, { callId: body.callId, status: "done", result }])
    expect(h.starts).toHaveLength(2)
    expect(await calls()).toHaveLength(1)
    expect(h.line("sandbox.call").map((line) => line.annotations.outcome)).toEqual(["running", "existing", "existing"])
    expect(h.count(SandboxCalls.requests, { route: "call", outcome: "existing" })).toBe(2)
  })

  test("the agent's call works in its answer's conversation, for the person who asked it only", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const elsewhere = await tracked(runtime, REPO, "feature/y")
    const mine = await asked(branch.conversationId, "person-member")
    const theirs = await asked(elsewhere.conversationId, "person-other")
    // The agent's call comes with its run credential, whose chain started from the answer.
    const h = await open({ ...member, act: { kind: "agent", id: `${mine.answerId}/call/0.1`, root: mine.answerId } })

    const callId = crypto.randomUUID()
    expect(await json(await post(h, { callId, call: { tool: "status" }, answerId: mine.answerId.toUpperCase() })))
      .toEqual([202, { callId, status: "running" }])
    expect(await calls()).toEqual([expect.objectContaining({ branchId: branch.branchId, answerId: mine.answerId })])
    expect(h.starts[0]).toMatchObject({ payload: { branch: { branchId: branch.branchId }, call: { tool: "status" } } })
    expect(h.only("sandbox.call").annotations).toMatchObject({ door: "agent", tool: "status" })

    // Any answer but its own run's is refused.
    const call = (on: BranchHarness, answerId: string) => post(on, { callId: crypto.randomUUID(), call: run, answerId })
    for (const answerId of [theirs.answerId, crypto.randomUUID(), mine.id]) {
      expect(await json(await call(h, answerId))).toEqual([403, { code: "other_run" }])
    }
    expect(h.starts).toHaveLength(1)
    // The person, in their own session, may name their own answer, as a resumed run with no credential does.
    expect((await call(await open(), mine.answerId)).status).toBe(202)
  })

  test("an agent's call for an answer that isn't the person's, or isn't there, is refused", async () => {
    const elsewhere = await tracked(runtime, REPO, "feature/y")
    const theirs = await asked(elsewhere.conversationId, "person-other")
    const missing = crypto.randomUUID()
    const call = async (answerId: string) => {
      const h = await open({ ...member, act: { kind: "agent", id: answerId, root: answerId } })
      return json(await post(h, { callId: crypto.randomUUID(), call: run, answerId }))
    }
    expect(await call(theirs.answerId)).toEqual([403, { code: "forbidden" }])
    expect(await call(missing)).toEqual([404, { code: "not_found" }])
  })

  test("only someone who may edit an unlocked branch calls: 401, 403 forbidden, 409 locked, 404 for no conversation", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const main = await tracked(runtime, REPO, "main", "locked")
    // Someone else's branch: shared with the Member to view, they may not run tools on it.
    const viewOnly = await tracked(runtime, REPO, "theirs", "open", "person-owner")
    await shared(runtime, viewOnly.branchId, "person-member", "view")
    const call = (h: BranchHarness, conversationId: string) =>
      post(h, { callId: crypto.randomUUID(), call: run, conversationId })

    expect(await json(await call(await open(null), branch.conversationId))).toEqual([401, { code: "authentication" }])
    for (const actor of [guest, { ...member, role: null }]) {
      expect(await json(await call(await open(actor), branch.conversationId))).toEqual([403, { code: "forbidden" }])
    }
    const h = await open()
    expect(await json(await call(h, viewOnly.conversationId))).toEqual([403, { code: "forbidden" }])
    expect(await json(await call(h, main.conversationId))).toEqual([409, { code: "locked" }])
    expect(await json(await call(h, crypto.randomUUID()))).toEqual([404, { code: "not_found" }])

    expect(h.line("sandbox.call").map((line) => [line.level, line.annotations.outcome])).toEqual([
      ["WARN", "forbidden"],
      ["WARN", "locked"],
      ["WARN", "not_found"],
    ])
    expect(h.count(SandboxCalls.requests, { route: "call", outcome: "locked" })).toBe(1)
    expect(h.starts).toEqual([])
    expect(await calls()).toEqual([])
  })

  test("refuses a body that isn't a call, names neither or both targets, is too large, and any method but POST", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const h = await open()
    const target = { conversationId: branch.conversationId }
    for (
      const body of [
        "not json",
        { callId: "not-a-uuid", call: run, ...target },
        { callId: crypto.randomUUID(), call: { tool: "format-disk" }, ...target },
        { callId: crypto.randomUUID(), call: { tool: "run", command: "" }, ...target },
        { callId: crypto.randomUUID(), call: { tool: "read" }, ...target },
        { callId: crypto.randomUUID(), call: run },
        { callId: crypto.randomUUID(), call: run, ...target, answerId: crypto.randomUUID() },
        { callId: crypto.randomUUID(), call: run, conversationId: "not-a-uuid" },
      ]
    ) {
      expect(await json(await post(h, body))).toEqual([400, { code: "invalid" }])
    }
    expect(await json(await post(h, "x".repeat(MAX_CALL_BODY_BYTES + 1)))).toEqual([413, { code: "invalid" }])
    expect(await json(await post(h, new Uint8Array([0x7b, 0xff, 0xfe])))).toEqual([400, { code: "invalid" }])
    const read = await h.fetch(SANDBOX_CALLS_ROUTE)
    expect([read.status, read.headers.get("allow")]).toEqual([405, "POST"])
    expect(h.line("sandbox.call").at(-1)!.annotations).toMatchObject({ status: 405, outcome: "refused" })
    expect(h.count(SandboxCalls.requests, { route: "call", outcome: "invalid" })).toBe(10)
    expect(h.starts).toEqual([])
    expect(await calls()).toEqual([])
  })

  test("an id another call holds is 409 id_taken: another person's, another tool's or another branch's", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const second = await tracked(runtime, REPO, "feature/y")
    const callId = crypto.randomUUID()
    const h = await open()
    expect((await post(h, { callId, call: run, conversationId: branch.conversationId })).status).toBe(202)

    const theirs = await open(other)
    expect(await json(await post(theirs, { callId, call: run, conversationId: branch.conversationId })))
      .toEqual([409, { code: "id_taken" }])
    expect(await json(await post(h, { callId, call: { tool: "status" }, conversationId: branch.conversationId })))
      .toEqual([409, { code: "id_taken" }])
    expect(await json(await post(h, { callId, call: run, conversationId: second.conversationId })))
      .toEqual([409, { code: "id_taken" }])
    expect(h.starts).toHaveLength(1)
    expect(await calls()).toEqual([expect.objectContaining({ id: callId, personId: "person-member", tool: "run" })])
  })

  test("a start the remote host refuses is 503, or 409 for another payload, and the call stays running for the resend", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    let refusal: "unavailable" | "conflict" | undefined = "unavailable"
    const started: Array<string> = []
    const h = await open(member, {
      starter: Flows.FlowStarter.of({
        start: (_, { executionId }) =>
          refusal === "unavailable"
            ? Effect.fail(new Flows.StartUnavailable({ errorCode: "rpc" }))
            : refusal === "conflict"
            ? Effect.fail(new Flows.StartConflict())
            : Effect.sync(() => void started.push(executionId)),
      }),
    })
    const body = { callId: crypto.randomUUID(), call: run, conversationId: branch.conversationId }

    expect(await json(await post(h, body))).toEqual([503, { code: "unavailable" }])
    expect(h.only("sandbox.call")).toMatchObject({
      level: "ERROR",
      annotations: { errorCode: "@smthrs/mvp/flows/StartUnavailable", status: 503, outcome: "unavailable" },
    })
    refusal = "conflict"
    expect(await json(await post(h, body))).toEqual([409, { code: "unavailable" }])
    expect(h.line("sandbox.call").at(-1)!.annotations).toMatchObject({ errorCode: "@smthrs/mvp/flows/StartConflict" })
    expect((await calls()).map((row) => row.status)).toEqual(["running"])

    refusal = undefined
    expect(await json(await post(h, body))).toEqual([200, { callId: body.callId, status: "running" }])
    expect(started).toEqual([callExecutionId(body.callId)])
  })

  test("sessions or Postgres that can't be read are 503 unavailable, logged by the failure's code", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const body = { callId: crypto.randomUUID(), call: run, conversationId: branch.conversationId }
    const sessions = await open(null, {
      sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })),
    })
    expect(await json(await post(sessions, body))).toEqual([503, { code: "unavailable" }])
    expect(sessions.only("sandbox.call").annotations).toMatchObject({ errorCode: "@smthrs/mvp/auth/SessionsUnavailable" })
    expect(await json(await get(sessions, body.callId))).toEqual([503, { code: "unavailable" }])

    const down = await open(member, {
      database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))),
    })
    expect(await json(await post(down, body))).toEqual([503, { code: "unavailable" }])
    expect(down.only("sandbox.call").annotations).toMatchObject({ errorCode: expect.stringMatching(/^sql:/) })
    expect(await json(await get(down, body.callId))).toEqual([503, { code: "unavailable" }])
    expect(down.only("sandbox.result").annotations).toMatchObject({ errorCode: expect.stringMatching(/^sql:/) })
  })
})

describe("GET /api/sandbox/calls/<id>", () => {
  test("the person who called reads how it stands: running, done with its result, failed with why", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const h = await open()
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()]
    for (const callId of [first, second]) {
      expect((await post(h, { callId, call: { tool: "read", path: "README.md" }, conversationId: branch.conversationId })).status)
        .toBe(202)
    }

    const running = await get(h, first.toUpperCase())
    expect(await json(running)).toEqual([200, { callId: first, status: "running" }])
    expect(running.headers.get("cache-control")).toBe("no-store")

    const result = { tool: "read", path: "README.md", content: SENTINEL, bytes: 15, truncated: false } as const
    await runtime.runPromise(settle(first, { status: "done", result, generation: 1 }))
    await runtime.runPromise(settle(second, { status: "failed", failure: "not_found" }))
    expect(await json(await get(h, first))).toEqual([200, { callId: first, status: "done", result }])
    expect(await json(await get(h, second))).toEqual([200, { callId: second, status: "failed", failure: "not_found" }])

    expect(h.line("sandbox.result").map((line) => [line.annotations.tool, line.annotations.outcome])).toEqual([
      ["read", "running"],
      ["read", "done"],
      ["read", "failed"],
    ])
    expect(h.count(SandboxCalls.requests, { route: "result", outcome: "done" })).toBe(1)
    // The file's content is the person's, never a record's.
    expect(recorded(h)).not.toContain(SENTINEL)
  })

  test("someone else's call, an unknown one and a malformed id are 404; signed out is 401; only GET", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const callId = crypto.randomUUID()
    expect((await post(await open(), { callId, call: run, conversationId: branch.conversationId })).status).toBe(202)

    expect(await json(await get(await open(other), callId))).toEqual([404, { code: "not_found" }])
    const h = await open()
    expect(await json(await get(h, crypto.randomUUID()))).toEqual([404, { code: "not_found" }])
    expect(await json(await get(h, "not-a-uuid"))).toEqual([404, { code: "not_found" }])
    expect(await json(await get(await open(null), callId))).toEqual([401, { code: "authentication" }])
    const wrong = await get(h, callId, "POST")
    expect([wrong.status, wrong.headers.get("allow")]).toEqual([405, "GET"])
  })
})

describe("handles", () => {
  test("names the sandbox call routes, and BranchApi hands them over", () => {
    for (const path of [SANDBOX_CALLS_ROUTE, `${SANDBOX_CALLS_ROUTE}/x`]) {
      expect([path, SandboxCalls.handles(path), BranchApi.handles(path)]).toEqual([path, true, true])
    }
    for (const path of ["/api/sandbox", "/api/sandbox/callsx", "/api/sandbox/call"]) {
      expect([path, SandboxCalls.handles(path)]).toEqual([path, false])
    }
  })
})


test("a failed launch keeps the persisted ephemeral namespace for retry", async () => {
  const { branch } = await runtime.runPromise(Conversations.track(REPO, "private-work", "open", "a".repeat(40), member.subject.id, undefined, "ephemeral"))
  const payloads: Array<unknown> = []
  const h = await open(member, { starter: { start: (_flow, options) => {
    payloads.push(options.payload)
    return Effect.fail(new Flows.StartUnavailable({ errorCode: "injected" }))
  } } })
  const body = { callId: crypto.randomUUID(), call: run, conversationId: branch.conversationId }
  const response = await post(h, body)
  expect(response.status).toBe(503)
  expect((await post(h, body)).status).toBe(503)
  expect(payloads).toHaveLength(2)
  expect(payloads[0]).toMatchObject({ branch: { branchId: branch.branchId, namespace: "ephemeral" } })
  expect(payloads[1]).toEqual(payloads[0])
  expect(await calls()).toEqual([
    { id: body.callId, branchId: branch.branchId, personId: member.subject.id, answerId: null, tool: "run", status: "running" },
  ])
})

test("a failed launch keeps the persisted GitHub forge for retry", async () => {
  const { branch } = await runtime.runPromise(Conversations.track(REPO, "private-work", "open", "a".repeat(40), member.subject.id, undefined, "default", "github"))
  const payloads: Array<unknown> = []
  const h = await open(member, { starter: { start: (_flow, options) => {
    payloads.push(options.payload)
    return Effect.fail(new Flows.StartUnavailable({ errorCode: "injected" }))
  } } })
  const body = { callId: crypto.randomUUID(), call: run, conversationId: branch.conversationId }
  const response = await post(h, body)
  expect(response.status).toBe(503)
  expect((await post(h, body)).status).toBe(503)
  expect(payloads).toHaveLength(2)
  expect(payloads[0]).toMatchObject({ branch: { branchId: branch.branchId, forge: "github" } })
  expect(payloads[1]).toEqual(payloads[0])
  expect(await calls()).toEqual([
    { id: body.callId, branchId: branch.branchId, personId: member.subject.id, answerId: null, tool: "run", status: "running" },
  ])
})
