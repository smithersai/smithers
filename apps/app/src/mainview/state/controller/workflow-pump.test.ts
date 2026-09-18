import { observeRuntimeRun, projectRuntimeCard, runtimeRunKey, type RuntimeRun } from "../RuntimeProjection"
import { canonicalEventValue } from "../EventValue"
import type { RuntimeRunObservation } from "../RuntimeProjection"
import { expect, test } from "bun:test"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import { createGatewaySeam } from "./gateway"
import { createWorkflowPumpController } from "./workflow-pump"
import type { StatusRollup } from "@smthrs/rpc/Health"

const event = (sequence: number) => ({ kind: "control.signal.delivered", sequence, occurredAt: sequence, payload: {} })
const failed = (sequence: number, cause: string) => ({ kind: "control.run.failed", sequence, occurredAt: sequence, payload: { cause } })
const summary = {
  runId: "run-1", flowId: "test", status: "running", createdAt: 1, updatedAt: 100,
  turns: 1, calls: 1, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
  inputTokens: 0, outputTokens: 0, verdict: "running", diagnosis: "moving"
}
const cursor = (projection: string, value: number, offset = 0) => ({
  selector: { _tag: projection, runId: "run-1" }, projection, runId: "run-1", value, offset
})
type Cycle = { events: ReturnType<typeof event>[]; revision?: number; journalFailure?: boolean; summaryFailure?: boolean; status?: string; verdict?: string; statusRollup?: StatusRollup }
const poll = async (cycles: Cycle[], options: {
  initialEvents?: ReturnType<typeof event>[]
  inspectAt?: number
  cloneStored?: boolean
  pageSize?: number
  flowId?: string
} = {}) => {
  const flowId = options.flowId ?? summary.flowId
  let card: Extract<Card, { kind: "run-trace" }> = {
    id: "run-card", kind: "run-trace", title: "test", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "o/r", runId: "run-1", workflow: flowId, phase: "running", steps: [], result: null, lastSeq: 0, events: options.initialEvents }
  }
  const cards = new Map([[card.id, card]])
  const scope = { repo: "o/r", runId: "run-1" }, key = runtimeRunKey(scope)
  const runtimeRuns = new Map<string, RuntimeRun>()
  if (options.initialEvents) runtimeRuns.set(key, observeRuntimeRun(undefined, {
    scope, journal: { mode: "full", events: options.initialEvents }
  }, Date.now(), 0))
  let iteration = -1
  let rowsRequested = 0
  const journalRequests: unknown[] = []
  const updates: typeof card[] = []
  const messages: string[] = []
  const gateway = createGatewaySeam({
    baseUrl: "https://test", errorMessageOf: async (_, fallback) => fallback,
    fetch: async (_, init) => {
      const { payload } = JSON.parse(String(init?.body))
      const projection = payload.selector._tag
      if (projection === "run-summary") iteration++
      const cycle = cycles[iteration]!
      if ((projection === "run-events" && cycle.journalFailure) || (projection === "run-summary" && cycle.summaryFailure)) {
        if (projection === "run-events") journalRequests.push(payload.after)
        return Response.json({ ok: false, error: { message: "offline" } })
      }
      let rows: unknown[] = [{ ...summary, flowId, updatedAt: cycle.status === undefined ? summary.updatedAt : summary.updatedAt + iteration + 1, status: cycle.status ?? "running", verdict: cycle.verdict ?? summary.verdict, statusRollup: cycle.statusRollup }]
      if (projection === "run-events") {
        journalRequests.push(payload.after)
        let offset = 0
        rows = cycle.events.filter((row, i) => {
          offset = i > 0 && cycle.events[i - 1]!.sequence === row.sequence ? offset + 1 : 0
          return payload.after === undefined || row.sequence > payload.after.value ||
            (row.sequence === payload.after.value && offset > payload.after.offset)
        })
        if (options.pageSize !== undefined) rows = rows.slice(0, options.pageSize)
        rowsRequested += rows.length
        if (options.inspectAt === iteration) {
          runtimeRuns.set(key, observeRuntimeRun(runtimeRuns.get(key), { scope, journal: { mode: "full", events: cycle.events } }, Date.now(), iteration + 1))
          card = projectRuntimeCard(card, [...runtimeRuns.values()], []) as typeof card
          cards.set(card.id, card)
        }
      }
      const last = cycle.events.at(-1)
      const offset = last === undefined ? 0 : cycle.events.filter((row) => row.sequence === last.sequence).length - 1
      return Response.json({ ok: true, payload: {
        rows, ...(cycle.revision === undefined ? {} : { cursor: cursor(projection, cycle.revision, offset) })
      } })
    }
  })
  const ctx = {
    finishTutorialChange: async () => {},
    store: { committedRuntimeRun: (id: string) => runtimeRuns.get(id), committedRuntimeApproval: () => undefined, collections: { cards, runtimeRuns, runtimeApprovals: new Map() }, dispatch: (action: any) => {
      if (action.type === "message.appended") messages.push(action.text)
      const previous = runtimeRuns.get(key)
      let next = previous
      if (action.type === "gateway.run.observed") next = observeRuntimeRun(previous, action.observation as RuntimeRunObservation, Date.now(), iteration + 1)
      if (action.type === "gateway.run.observer.changed" && canonicalEventValue(previous?.observer) !== canonicalEventValue(action.observer)) {
        next = { ...(previous ?? { id: key, scope, events: [], steps: [], revision: 0 }), observer: action.observer, observedAt: Date.now() }
      }
      if (next !== undefined && next !== previous) {
        runtimeRuns.set(key, options.cloneStored ? structuredClone(next) : next)
        card = projectRuntimeCard(card, [...runtimeRuns.values()], []) as typeof card
        cards.set(card.id, card)
        updates.push(card)
      }
      return { isPersisted: { promise: Promise.resolve() } }
    } },
    gateway, runPumps: new Map<string, { stopped: boolean }>(), pumpPokes: new Map<string, () => void>(),
    workflowPollMs: 1, services: {},
    unref: (timer: ReturnType<typeof setTimeout>) => {
      clearTimeout(timer)
      queueMicrotask(() => {
        if (iteration === cycles.length - 1) for (const pump of ctx.runPumps.values()) pump.stopped = true
        ctx.pumpPokes.get(card.id)?.()
      })
    }
  }
  await createWorkflowPumpController(ctx as unknown as ControllerContext, () => 1).pumpWorkflowRun(card.id)
  return { card, updates, rowsRequested, journalRequests, messages }
}

test("a failed run keeps raw evidence on its card and announces only typed human copy", async () => {
  const raw = "failed — Error: Error: git exited 1"
  const result = await poll([{ events: [], status: "failed", verdict: raw }])
  expect(result.card.payload.error).toBe(raw)
  expect(result.messages.join(" ")).toContain("Not your fault")
  expect(result.messages.join(" ")).not.toContain(raw)
})

test("a settled registrar refusal is transcribed as the sentence the card leads with", async () => {
  const refusal = 'Add a model to "nightly-lint" to schedule it.'
  const verdict = `failed — invalid_receipt: ${refusal}`
  const cause = `invalid_receipt: ${refusal}\n    at repository/trigger (flows/repository/triggers.ts:20:11)`
  const result = await poll([{ events: [failed(1, cause)], revision: 1, status: "failed", verdict }], { flowId: "repository/trigger" })
  expect(result.card.payload.error).toBe(verdict)
  expect(result.messages).toEqual([`The run failed: ${refusal}`])
})

test("a settled setup refusal is transcribed as the sentence the person has to answer", async () => {
  const refusal = "Run evals for this exact candidate before continuing"
  const verdict = `failed — invalid_receipt: ${refusal}`
  const cause = `invalid_receipt: ${refusal}\n    at repository/Setup (flows/repository/receipts.ts:109)`
  const result = await poll([{ events: [failed(1, cause)], revision: 1, status: "failed", verdict }], { flowId: "repository/setup" })
  expect(result.card.payload.error).toBe(verdict)
  expect(result.messages).toEqual([`The run failed: ${refusal}`])
})

test("another flow's invalid_receipt is still Smithers' in the transcript", async () => {
  const verdict = "failed — invalid_receipt: Native source creation returned an invalid receipt"
  const result = await poll([{ events: [failed(1, verdict.slice("failed — ".length))], revision: 1, status: "failed", verdict }], { flowId: "coding/request" })
  expect(result.card.payload.error).toBe(verdict)
  expect(result.messages.join(" ")).toContain("Not your fault")
})

test("four unchanged iterations read and dispatch a 20,000-row journal only once", async () => {
  const events = Array.from({ length: 20_000 }, (_, i) => event(i + 1))
  const result = await poll(Array.from({ length: 4 }, () => ({ events, revision: 20_000 })))
  expect(result.rowsRequested).toBe(20_000)
  // One call reads the page and a second confirms it was the whole suffix,
  // because a full-looking page means there may be another. The other three
  // iterations read nothing at all.
  expect(result.journalRequests).toHaveLength(2)
  expect(result.updates).toHaveLength(1)
  expect(result.card.payload.events).toHaveLength(20_000)
})
test("only new rows append, including distinct events sharing a sequence", async () => {
  const first = [event(1)]
  const second = [...first, event(1)]
  const third = [...second, event(2)]
  const result = await poll([
    { events: first, revision: 1 }, { events: second, revision: 1 },
    { events: third, revision: 2 }, { events: third, revision: 2 }
  ])
  expect(result.rowsRequested).toBe(3)
  expect(result.journalRequests).toEqual([undefined, cursor("run-events", 1), cursor("run-events", 1, 1)])
  expect(result.updates).toHaveLength(3)
  expect(result.card.payload.events).toEqual(third)
  expect(result.updates[0]!.payload.events![0]).toBe(result.card.payload.events![0])
  expect(result.updates[0]!.payload.events).toHaveLength(1)
})
test("without revisions polling still requests only the suffix and skips unchanged dispatches", async () => {
  const events = [event(1), event(2)]
  const result = await poll(Array.from({ length: 4 }, () => ({ events })))
  expect(result.rowsRequested).toBe(2)
  expect(result.journalRequests).toEqual([undefined, cursor("run-events", 2), cursor("run-events", 2), cursor("run-events", 2)])
  expect(result.updates).toHaveLength(1)
})
test("a full page without cursor metadata advances from recorded event positions", async () => {
  const events = Array.from({ length: 600 }, (_, index) => event(index))
  const result = await poll([{ events }, { events }], { pageSize: 256 })
  expect(result.journalRequests).toEqual([
    undefined, cursor("run-events", 255), cursor("run-events", 511), cursor("run-events", 599)
  ])
  expect(result.rowsRequested).toBe(600)
  expect(result.card.payload.events).toEqual(events)
  expect(result.updates).toHaveLength(1)
})
test("cursor-free pages keep duplicate-sequence offsets across page boundaries", async () => {
  const events = Array.from({ length: 600 }, () => event(0))
  const result = await poll([{ events }, { events }], { pageSize: 256 })
  expect(result.journalRequests).toEqual([
    undefined, cursor("run-events", 0, 255), cursor("run-events", 0, 511), cursor("run-events", 0, 599)
  ])
  expect(result.rowsRequested).toBe(600)
  expect(result.card.payload.events).toEqual(events)
  expect(result.updates).toHaveLength(1)
})
test("a failed journal read is retried at the same revision without losing the prefix", async () => {
  const first = [event(1)]
  const events = [...first, event(2)]
  const result = await poll([
    { events: first, revision: 1 }, { events, revision: 2, journalFailure: true },
    { events, revision: 2 }, { events, revision: 2 }
  ])
  expect(result.rowsRequested).toBe(2)
  expect(result.journalRequests).toHaveLength(3)
  expect(result.card.payload.events).toEqual(events)
})
test("unchanged journal revisions still recover reconnecting cards and render terminal status", async () => {
  const events = [event(1)]
  const result = await poll([
    { events, revision: 1 }, { events, revision: 1, summaryFailure: true },
    { events, revision: 1, summaryFailure: true }, { events, revision: 1 },
    { events, revision: 1, status: "completed" }
  ])
  expect(result.updates.map((card) => card.payload.phase)).toEqual(["running", "reconnecting", "running", "completed"])
  expect(result.rowsRequested).toBe(1)
  expect(result.card.status).toBe("acted")
})

test("a resumed pump starts after the journal already retained on the card", async () => {
  const initialEvents = [event(0), event(0)]
  const events = [...initialEvents, event(1)]
  const result = await poll([{ events, revision: 1 }], { initialEvents })
  expect(result.journalRequests).toEqual([cursor("run-events", 0, 1)])
  expect(result.rowsRequested).toBe(1)
  expect(result.card.payload.events).toEqual(events)
  expect(result.card.payload.events![0]).toEqual(initialEvents[0])
})

test("a full inspection arriving during a suffix read does not duplicate events", async () => {
  const initialEvents = [event(1)]
  const events = [...initialEvents, event(2)]
  const result = await poll([{ events, revision: 2 }, { events, revision: 2 }], { initialEvents, inspectAt: 0 })
  expect(result.card.payload.events).toEqual(events)
  expect(result.journalRequests).toEqual([cursor("run-events", 1), cursor("run-events", 2)])
})

test("store validation copying a payload does not invalidate its journal revision", async () => {
  const events = [event(1)]
  const result = await poll(Array.from({ length: 4 }, () => ({ events, revision: 1 })), { cloneStored: true })
  expect(result.journalRequests).toHaveLength(1)
  expect(result.updates).toHaveLength(1)
})

test("an empty journal does not hide its first sequence-zero event at the same cursor", async () => {
  const events = [event(0)]
  const result = await poll([{ events: [], revision: 0 }, { events, revision: 0 }, { events, revision: 0 }])
  expect(result.journalRequests).toEqual([undefined, undefined])
  expect(result.rowsRequested).toBe(1)
  expect(result.card.payload.events).toEqual(events)
})

test("run health uses the existing summary projection, expires old working and refuses another run or lifecycle", async () => {
  const now = Date.now()
  const statusRollup: StatusRollup = { subjectId: "run:run-1", state: "running", activity: "working", health: "healthy",
    freshness: "fresh", attention: "none", updatedAt: now,
    provenance: { checkerId: "test", monitorId: "host", observedAt: now - 100, expiresAt: now - 1,
      evidenceSeq: 1, incarnation: "owner", version: 2 } }
  const expired = await poll([{ events: [], revision: 1, statusRollup }])
  expect(expired.card.payload.statusRollup).toMatchObject({ freshness: "stale", activity: "unknown", health: "unknown" })
  expect(expired.card.payload.phase).toBe("running")
  expect((await poll([{ events: [], statusRollup: { ...statusRollup, subjectId: "run:other" } }])).card.payload.statusRollup).toBeUndefined()
  expect((await poll([{ events: [], statusRollup: { ...statusRollup, state: "completed" } }])).card.payload.statusRollup).toBeUndefined()
  const terminal = await poll([{ events: [], status: "failed", statusRollup: { ...statusRollup, state: "failed", health: "failing" } }])
  expect(terminal.card.payload.statusRollup?.health).toBe("failing")
  expect(terminal.card.payload.phase).toBe("failed")
})
