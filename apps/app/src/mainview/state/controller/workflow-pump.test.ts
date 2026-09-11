import { expect, test } from "bun:test"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import { createGatewaySeam } from "./gateway"
import { createWorkflowPumpController } from "./workflow-pump"

const event = (sequence: number) => ({ kind: "control.signal.delivered", sequence, occurredAt: sequence, payload: {} })
const summary = {
  runId: "run-1", flowId: "test", status: "running", createdAt: 1, updatedAt: 100,
  turns: 1, calls: 1, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
  inputTokens: 0, outputTokens: 0, verdict: "running", diagnosis: "moving"
}
const cursor = (projection: string, value: number, offset = 0) => ({
  selector: { _tag: projection, runId: "run-1" }, projection, runId: "run-1", value, offset
})
type Cycle = { events: ReturnType<typeof event>[]; revision?: number; journalFailure?: boolean; summaryFailure?: boolean; status?: string }
const poll = async (cycles: Cycle[], options: {
  initialEvents?: ReturnType<typeof event>[]
  inspectAt?: number
  cloneStored?: boolean
} = {}) => {
  let card: Extract<Card, { kind: "run-trace" }> = {
    id: "run-card", kind: "run-trace", title: "test", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "o/r", runId: "run-1", workflow: "test", phase: "running", steps: [], result: null, lastSeq: 0, events: options.initialEvents }
  }
  const cards = new Map([[card.id, card]])
  let iteration = -1
  let rowsRequested = 0
  const journalRequests: unknown[] = []
  const updates: typeof card[] = []
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
      let rows: unknown[] = [{ ...summary, status: cycle.status ?? "running" }]
      if (projection === "run-events") {
        journalRequests.push(payload.after)
        let offset = 0
        rows = cycle.events.filter((row, i) => {
          offset = i > 0 && cycle.events[i - 1]!.sequence === row.sequence ? offset + 1 : 0
          return payload.after === undefined || row.sequence > payload.after.value ||
            (row.sequence === payload.after.value && offset > payload.after.offset)
        })
        rowsRequested += rows.length
        if (options.inspectAt === iteration) {
          card = { ...card, payload: { ...card.payload, events: cycle.events } }
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
    store: { collections: { cards }, dispatch: (action: any) => {
      if (action.type !== "card.updated") return
      card = { ...card, ...action.patch }
      if (options.cloneStored) card = structuredClone(card)
      cards.set(card.id, card)
      updates.push(card)
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
  return { card, updates, rowsRequested, journalRequests }
}

test("four unchanged iterations read and dispatch a 20,000-row journal only once", async () => {
  const events = Array.from({ length: 20_000 }, (_, i) => event(i + 1))
  const result = await poll(Array.from({ length: 4 }, () => ({ events, revision: 20_000 })))
  expect(result.rowsRequested).toBe(20_000)
  expect(result.journalRequests).toHaveLength(1)
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
  expect(result.card.payload.events![0]).toBe(initialEvents[0])
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
