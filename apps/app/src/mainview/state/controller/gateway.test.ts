/*
 * The workspace gateway seam, against a relay double: every projection and
 * operation lane runs added rides the one relay envelope, and the payload each
 * sends is the gateway's own procedure shape — a drift between this file and
 * the allowlisted procedures fails here, not in a browser.
 */
import { describe, expect, test } from "bun:test"
import { createGatewaySeam, INVALID_PROJECTION_CODE } from "./gateway"

interface RecordedCall {
  readonly repo: string
  readonly procedure: string
  readonly payload: unknown
}

/** A relay double: records the envelope, answers one scripted payload (or refusal) per procedure. */
const relay = (answers: Readonly<Record<string, unknown>> = {}) => {
  const calls: Array<RecordedCall> = []
  const seam = createGatewaySeam({
    baseUrl: "https://app.test",
    fetch: async (url, init) => {
      expect(url).toBe("https://app.test/api/workflow/rpc")
      const body = JSON.parse(String(init?.body ?? "{}")) as RecordedCall
      calls.push(body)
      const answer = answers[body.procedure] ?? { ok: true, payload: {} }
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    },
    errorMessageOf: async (_response, fallback) => fallback
  })
  return { calls, seam }
}

const rowsAnswer = (rows: ReadonlyArray<unknown>) => ({
  ok: true,
  payload: { cursor: { projection: "test", runId: null, value: 0 }, rows }
})

/** The per-invocation nonce every control mutation mints: one `crypto.randomUUID()`, never the clock. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

const keysOf = (calls: ReadonlyArray<RecordedCall>): ReadonlyArray<string> =>
  calls.map((call) => String((call.payload as { idempotencyKey: unknown }).idempotencyKey))

describe("the run lifecycle operations", () => {
  test("cancel carries the human's reason, defaulting to the standing one", async () => {
    const { calls, seam } = relay()
    expect((await seam.cancel("o/r", "run-1")).status).toBe("ok")
    expect((await seam.cancel("o/r", "run-1", "it hung")).status).toBe("ok")
    expect((await seam.cancel("o/r", "run-1", "  ")).status).toBe("ok")
    expect(calls.map((call) => call.payload)).toEqual([
      { runId: "run-1", idempotencyKey: "cancel:run-1", reason: "the human stopped it" },
      { runId: "run-1", idempotencyKey: "cancel:run-1", reason: "it hung" },
      { runId: "run-1", idempotencyKey: "cancel:run-1", reason: "the human stopped it" }
    ])
    expect(calls.every((call) => call.procedure === "Cancel" && call.repo === "o/r")).toBe(true)
  })

  test("resume sends the control mutation with an idempotency key and optional reason", async () => {
    const { calls, seam } = relay()
    expect((await seam.resume("o/r", "run-1", "nothing was driving it")).status).toBe("ok")
    const payload = calls[0]?.payload as Record<string, unknown>
    expect(calls[0]?.procedure).toBe("Resume")
    expect(payload.runId).toBe("run-1")
    expect(payload.reason).toBe("nothing was driving it")
    expect(String(payload.idempotencyKey)).toMatch(new RegExp(`^resume:run-1:${UUID}$`))
  })

  test("signal sends the named signal with its JSON payload", async () => {
    const { calls, seam } = relay()
    expect((await seam.signal("o/r", "run-1", "deploy-done", { ok: true })).status).toBe("ok")
    const payload = calls[0]?.payload as Record<string, unknown>
    expect(calls[0]?.procedure).toBe("Signal")
    expect(payload.runId).toBe("run-1")
    expect(payload.signal).toEqual({ name: "deploy-done", payload: { ok: true } })
    expect(String(payload.idempotencyKey)).toMatch(new RegExp(`^signal:run-1:deploy-done:${UUID}$`))
  })

  test("a signal without a payload sends the empty object", async () => {
    const { calls, seam } = relay()
    await seam.signal("o/r", "run-1", "deploy-done", undefined)
    expect((calls[0]?.payload as { signal: unknown }).signal).toEqual({ name: "deploy-done", payload: {} })
  })

  test("every mutation mints its own key, so two acts in one millisecond stay two", async () => {
    const realNow = Date.now
    Date.now = () => 1_700_000_000_000
    try {
      const { calls, seam } = relay()
      await seam.resume("o/r", "run-1")
      await seam.resume("o/r", "run-1")
      await seam.signal("o/r", "run-1", "next", {})
      await seam.signal("o/r", "run-1", "next", {})
      await seam.steer("o/r", "run-1", { kind: "Seat", seat: "one" })
      await seam.steer("o/r", "run-1", { kind: "Thinking", thinking: "high" })
      const keys = keysOf(calls)
      expect(keys).toHaveLength(6)
      expect(new Set(keys).size).toBe(6)
      // The steer envelope carries its own identity, and it is per invocation too.
      const messageIds = calls.slice(4).map((call) =>
        String((call.payload as { message: { messageId: unknown } }).message.messageId)
      )
      expect(new Set(messageIds).size).toBe(2)
    } finally {
      Date.now = realNow
    }
  })

  test("a refusal crosses as the seam's error, message first", async () => {
    const { seam } = relay({ Signal: { ok: false, error: { message: "NoMatchingWait: no wait named deploy-done" } } })
    const result = await seam.signal("o/r", "run-1", "deploy-done", {})
    expect(result).toEqual({ status: "error", message: "NoMatchingWait: no wait named deploy-done" })
  })
})

describe("steer", () => {
  const envelopeOf = (payload: unknown): Record<string, unknown> =>
    (payload as { message: Record<string, unknown> }).message

  test("an operator message carries the steer envelope and the body", async () => {
    const { calls, seam } = relay()
    expect((await seam.steer("o/r", "run-1", { kind: "Message", body: "use the smaller diff" })).status).toBe("ok")
    expect(calls[0]?.procedure).toBe("Steer")
    const payload = calls[0]?.payload as Record<string, unknown>
    expect(payload.runId).toBe("run-1")
    expect(String(payload.idempotencyKey)).toMatch(new RegExp(`^steer:run-1:${UUID}$`))
    const message = envelopeOf(calls[0]?.payload)
    expect(message.kind).toBe("Message")
    expect(message.body).toBe("use the smaller diff")
    expect(message.runId).toBe("run-1")
    expect(String(message.messageId)).toMatch(new RegExp(`^steer-run-1-${UUID}$`))
    // The placeholder principal the server overwrites with the authenticated one.
    expect(message.principal).toMatchObject({ kind: "user" })
    expect(typeof message.createdAt).toBe("number")
  })

  test("the seat, thinking, and tools variants carry their own fields", async () => {
    const { calls, seam } = relay()
    await seam.steer("o/r", "run-1", { kind: "Seat", seat: "anthropic:claude-opus-4-1" })
    await seam.steer("o/r", "run-1", { kind: "Thinking", thinking: "high" })
    await seam.steer("o/r", "run-1", { kind: "Tools", toolNames: ["bash", "edit"] })
    expect(envelopeOf(calls[0]?.payload)).toMatchObject({ kind: "Seat", seat: "anthropic:claude-opus-4-1" })
    expect(envelopeOf(calls[1]?.payload)).toMatchObject({ kind: "Thinking", thinking: "high" })
    expect(envelopeOf(calls[2]?.payload)).toMatchObject({ kind: "Tools", toolNames: ["bash", "edit"] })
  })
})

describe("the run projections", () => {
  /** A complete run summary, as the workspace-runs projection answers it. */
  const summaryRow = {
    runId: "run-1",
    flowId: "review-pr",
    status: "running" as const,
    createdAt: 1000,
    updatedAt: 2000,
    turns: 3,
    calls: 5,
    callsFailed: 0,
    editsAttempted: 1,
    editsSucceeded: 1,
    inputTokens: 100,
    outputTokens: 50,
    verdict: "running",
    diagnosis: "The run is moving."
  }
  /** A complete approval, as the approvals projection answers it. */
  const approvalRow = {
    runId: "run-1",
    requestId: "req-1",
    title: "Run the deploy script?",
    request: { question: "Run the deploy script?" },
    payload: {
      target: {
        _tag: "Node" as const,
        runId: "run-1",
        requestId: "req-1",
        digest: "sha256:test",
        envelope: { capabilities: [], flows: [], budget: { milliseconds: undefined, tokens: undefined } }
      },
      scope: "run" as const,
      idempotencyKey: "approve:req-1"
    },
    requestedAt: 1500,
    status: "pending" as const
  }

  test("workspaceRuns selects workspace-runs and answers the summary rows", async () => {
    const rows = [summaryRow]
    const { calls, seam } = relay({ "Projection.Snapshot": rowsAnswer(rows) })
    const result = await seam.workspaceRuns("o/r")
    expect(calls[0]?.payload).toEqual({ selector: { _tag: "workspace-runs" } })
    expect(result).toEqual({ status: "ok", value: rows })
  })

  test("approvalsInbox selects approvals WITHOUT a run id", async () => {
    const rows = [approvalRow]
    const { calls, seam } = relay({ "Projection.Snapshot": rowsAnswer(rows) })
    const result = await seam.approvalsInbox("o/r")
    expect(calls[0]?.payload).toEqual({ selector: { _tag: "approvals" } })
    expect(result).toEqual({ status: "ok", value: rows })
  })

  test("a run's approvals still select with its run id", async () => {
    const { calls, seam } = relay({ "Projection.Snapshot": rowsAnswer([]) })
    await seam.approvals("o/r", "run-1")
    expect(calls[0]?.payload).toEqual({ selector: { _tag: "approvals", runId: "run-1" } })
  })

  test("transcript and runEvents select their projections for the run", async () => {
    const line = { runId: "run-1", sequence: 1, turn: 1, at: 1000, kind: "turn.opened", text: "opened" }
    const lines = relay({ "Projection.Snapshot": rowsAnswer([line]) })
    const transcript = await lines.seam.transcript("o/r", "run-1")
    expect(lines.calls[0]?.payload).toEqual({ selector: { _tag: "transcript", runId: "run-1" } })
    expect(transcript).toEqual({ status: "ok", value: [line] })
    const event = { kind: "control.run.accepted", payload: {}, sequence: 1, occurredAt: 1000 }
    const journal = relay({ "Projection.Snapshot": rowsAnswer([event]) })
    const events = await journal.seam.runEvents("o/r", "run-1")
    expect(journal.calls[0]?.payload).toEqual({ selector: { _tag: "run-events", runId: "run-1" } })
    expect(events).toEqual({ status: "ok", value: [event] })
  })

  test("a valid empty rows array is the empty listing", async () => {
    const { seam } = relay({ "Projection.Snapshot": rowsAnswer([]) })
    expect(await seam.workspaceRuns("o/r")).toEqual({ status: "ok", value: [] })
  })

  test("a snapshot the served schema rejects is a refusal, never an empty workspace", async () => {
    // A missing envelope, a null row, and a row whose fields the gateway never
    // serves: each is a malformed answer, and reading it as [] would tell the
    // human this workspace has no runs.
    for (
      const payload of [
        { cursor: {} },
        { cursor: {}, rows: "all of them" },
        rowsAnswer([null]).payload,
        rowsAnswer([{ runId: 42, status: "invented" }]).payload
      ]
    ) {
      const { seam } = relay({ "Projection.Snapshot": { ok: true, payload } })
      expect(await seam.workspaceRuns("o/r")).toEqual({
        status: "error",
        message: "The workspace answered with a projection I couldn't read.",
        code: INVALID_PROJECTION_CODE
      })
    }
  })

  test("a run whose summary row is malformed refuses instead of reading as no such run", async () => {
    const { seam } = relay({ "Projection.Snapshot": rowsAnswer([{ ...summaryRow, status: "invented" }]) })
    const result = await seam.run("o/r", "run-1")
    expect(result.status).toBe("error")
    expect(result).toMatchObject({ code: INVALID_PROJECTION_CODE })
  })

  test("an approvals inbox row the schema rejects refuses instead of reading as no gates", async () => {
    const { seam } = relay({ "Projection.Snapshot": rowsAnswer([{ ...approvalRow, payload: { scope: "run" } }]) })
    expect((await seam.approvalsInbox("o/r")).status).toBe("error")
  })
})

describe("owning workspace binding", () => {
  test("pins Plan, approval and Run to the original selection and records it for the run", async () => {
    const first = "83e75ae5-0920-4000-8000-000000000001"
    let selected = first
    const calls: Array<{ procedure: string; workspaceId?: string }> = []
    const seam = createGatewaySeam({
      baseUrl: "https://app.test",
      bindingFor: () => ({ workspaceId: selected }),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        calls.push(body)
        selected = "83e75ae5-0920-4000-8000-000000000002"
        return new Response(JSON.stringify({ ok: true, payload: body.procedure === "Plan"
          ? { planId: "plan", digest: "digest", envelope: {} }
          : body.procedure === "Run" ? { runId: "run" } : {} }))
      },
      errorMessageOf: async (_response, fallback) => fallback
    })
    expect(await seam.launch("o/r", "coding", { plan: {} })).toEqual({ status: "ok", value: { runId: "run", workspaceId: first } })
    expect(calls.map((call) => call.workspaceId)).toEqual([first, first, first])
    expect(calls.map((call) => call.procedure)).toEqual(["Plan", "Approval.Submit", "Run"])
  })

  test("routes run projections and approvals by their run identity and refuses an invalid binding before transport", async () => {
    const ids: Array<string | undefined> = []
    let requests = 0
    const seam = createGatewaySeam({
      baseUrl: "https://app.test",
      bindingFor: (_repo, runId) => { ids.push(runId); return { error: "The run belongs to another repository." } },
      fetch: async () => { requests += 1; return new Response() },
      errorMessageOf: async (_response, fallback) => fallback
    })
    expect((await seam.runEvents("o/r", "run-1")).status).toBe("error")
    expect((await seam.cancel("o/r", "run-1")).status).toBe("error")
    expect(ids).toEqual(["run-1", "run-1"])
    expect(requests).toBe(0)
  })
})

test("runEvents forwards the exact cursor and preserves the issued revision", async () => {
  const selector = { _tag: "run-events" as const, runId: "run-1" }
  const after = { selector, projection: "run-events" as const, runId: "run-1", value: 42, offset: 1 }
  const next = { ...after, value: 43, offset: 0 }
  const event = { kind: "control.run.accepted", payload: {}, sequence: 43, occurredAt: 1000 }
  const { calls, seam } = relay({ "Projection.Snapshot": { ok: true, payload: { rows: [event], cursor: next } } })
  expect(await seam.runEvents("o/r", "run-1", undefined, after)).toEqual({ status: "ok", value: [event], cursor: next })
  expect(calls[0]?.payload).toEqual({ selector, after })
  await seam.runEvents("o/r", "run-1")
  expect(calls[1]?.payload).toEqual({ selector })
})
