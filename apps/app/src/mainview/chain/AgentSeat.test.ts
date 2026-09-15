import { expect, test } from "bun:test"
import type { AgentTurnCursor, AgentTurnJournalDelivery } from "@smthrs/rpc/AgentTurnJournal"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../runtime/AgentPort"
import { createAgentSeat } from "./ChainRuntime"

const access = { runId: "turn", journal: { version: 1 as const, legId: "leg", token: "a".repeat(64) } }
const request: StartAgentTurnRequest = { ...access, messages: [], instructions: "" }
const cursor: AgentTurnCursor = { version: 1, runId: "turn", legId: "leg", batch: 0, position: 0, hash: "a".repeat(64) }
const backend = () => {
  const starts: StartAgentTurnRequest[] = [], calls: string[] = []
  let publish!: (delivery: AgentTurnJournalDelivery) => Promise<void>
  const agent: AgentPort = {
    available: true, subscribe: () => () => {},
    startTurn: async value => { starts.push(value); return { status: "started" } },
    cancelTurn: async runId => { calls.push(`cancel:${runId}`) },
    journal: {
      subscribe: listener => { publish = listener; return () => {} },
      read: async value => { calls.push(`read:${value.runId}`); return { status: "existing", cursor, terminal: false } },
      retire: async value => { calls.push(`retire:${value.runId}`) },
      disconnect: runId => { calls.push(`disconnect:${runId}`) }
    }
  }
  return { agent, starts, calls, emit: (delivery: AgentTurnJournalDelivery) => publish(delivery) }
}

test("the seat forwards journal commit backpressure and preserves the accepted backend after chain binding", async () => {
  const first = backend(), next = backend(), seat = createAgentSeat(first.agent), journal = seat.journal!
  let release!: () => void, committed = false
  const held = new Promise<void>(resolve => { release = resolve })
  journal.subscribe(async () => { await held; committed = true })
  await seat.startTurn(request)
  const receipt = first.emit({ type: "accepted", cursor })
  await Promise.resolve()
  expect(committed).toBe(false)
  release(); await receipt
  expect(committed).toBe(true)
  seat.bindChain(next.agent)
  await journal.read(access)
  await seat.cancelTurn(access.runId)
  journal.disconnect(access.runId)
  await journal.retire(access)
  await seat.startTurn({ ...request, journal: { ...request.journal!, legId: "continuation" } })
  expect(first.calls).toEqual(["read:turn", "cancel:turn", "disconnect:turn", "retire:turn"])
  expect(first.starts).toHaveLength(2)
  expect(next.starts).toHaveLength(0)
  expect(next.calls).toEqual([])
})

test("a recovery read establishes the cancel owner without starting a producer", async () => {
  const first = backend(), seat = createAgentSeat(first.agent), journal = seat.journal!
  await journal.read(access)
  const legacy: AgentPort = { available: true, startTurn: async () => { throw new Error("Unexpected chain start") }, cancelTurn: async () => { throw new Error("Wrong cancel backend") }, subscribe: () => () => {} }
  seat.bindChain(legacy)
  expect(seat.journal).toBeUndefined()
  await seat.cancelTurn(access.runId)
  journal.disconnect(access.runId)
  expect(first.calls).toEqual(["read:turn", "cancel:turn", "disconnect:turn"])
  expect(first.starts).toHaveLength(0)
})
