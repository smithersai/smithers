import { expect, test } from "bun:test"
import { digest } from "@smthrs/core/Digest"
import { agentTurnJournalDigestInput, type AgentTurnBatch, type AgentTurnCursor, type AgentTurnJournalDelivery } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { assertTurnTrafficProtocol, inspectTurnTraffic, parseTurnFrames } from "../real/chat-tools/traffic"

const accepted = (legId = "leg-1"): AgentTurnCursor => ({ version: 1, runId: "run", legId, batch: 0, position: 0, hash: "a".repeat(64) })
const batch = (cursor: AgentTurnCursor, frames: AgentTurnFrame[]): Extract<AgentTurnJournalDelivery, { type: "batch" }> => {
  const body = { version: 1 as const, runId: cursor.runId, legId: cursor.legId, batch: cursor.batch + 1,
    from: cursor.position + 1, previousHash: cursor.hash, frames }
  const batch: AgentTurnBatch = { ...body, hash: digest(agentTurnJournalDigestInput("batch", body)) }
  return { type: "batch", batch, cursor: { ...cursor, batch: batch.batch, position: cursor.position + frames.length, hash: batch.hash } }
}
const ndjson = (...records: readonly unknown[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n"
const delta: AgentTurnFrame = { type: "delta", runId: "run", kind: "text", text: "observed café\n" }
const done: AgentTurnFrame = { type: "done", runId: "run" }
const full = () => {
  const start = accepted()
  const first = batch(start, [delta])
  const last = batch(first.cursor, [done])
  return { start, first, last, body: ndjson({ type: "accepted", cursor: start }, first, last) }
}

test("durable traffic waits for a complete terminal record and preserves observed frames and batch cursors", () => {
  const { start, first, last, body } = full()
  for (const end of [0, 1, 17, body.indexOf("café") + 2, body.length - 10, body.length - 1]) {
    expect(inspectTurnTraffic(body.slice(0, end)).complete).toBe(false)
  }
  const observed = inspectTurnTraffic(body)
  expect(observed.complete).toBe(true)
  expect(observed.cursor).toEqual(last.cursor)
  expect(observed.frames).toEqual([
    { ...delta, journal: { accepted: start, cursor: first.cursor, position: 1 } },
    { ...done, journal: { accepted: start, cursor: last.cursor, position: 2 } }
  ])
  expect(parseTurnFrames([body])).toEqual(observed.frames)
  expect(parseTurnFrames([body + ndjson({ type: "caught-up", cursor: last.cursor, terminal: true })])).toEqual(observed.frames)
})

test("sequential tool legs keep response/frame order without treating envelopes as model output", () => {
  const first = accepted("tool"), next = accepted("answer")
  const call: AgentTurnFrame = { type: "tool_call", runId: "run", call_id: "call-1", name: "commands",
    arguments: JSON.stringify({ action: "execute", name: "files.read", args: "README.md" }) }
  const tool = batch(first, [call, done]), answer = batch(next, [delta, done])
  const frames = parseTurnFrames([ndjson({ type: "accepted", cursor: first }, tool), ndjson({ type: "accepted", cursor: next }, answer)])
  expect(frames.map(frame => frame.type)).toEqual(["tool_call", "done", "delta", "done"])
  expect(frames.map(frame => [frame.journal?.cursor.legId, frame.journal?.position])).toEqual([["tool", 1], ["tool", 2], ["answer", 1], ["answer", 2]])
})

test("heads, catch-up claims and partial bytes cannot substitute for an observed terminal", () => {
  const { start, first, last, body } = full()
  const unfinished = ndjson({ type: "accepted", cursor: start }, first)
  expect(inspectTurnTraffic(unfinished + ndjson({ type: "caught-up", cursor: first.cursor, terminal: false })).complete).toBe(false)
  expect(() => parseTurnFrames([unfinished])).toThrow("terminal frame")
  expect(() => parseTurnFrames([body.slice(0, -1)])).toThrow("terminal frame")
  expect(() => parseTurnFrames([])).toThrow("No turn traffic")
  expect(() => parseTurnFrames([ndjson({ type: "accepted", cursor: start }, first, { type: "caught-up", cursor: last.cursor, terminal: true })])).toThrow()
  expect(() => parseTurnFrames([ndjson({ status: "existing", cursor: last.cursor, terminal: true })])).toThrow()
})

test("delivery cursor mismatch, malformed output and out-of-order batches are refused by the shared verifier composition", () => {
  const { start, first, last, body } = full()
  expect(() => parseTurnFrames([ndjson({ type: "accepted", cursor: start }, { ...first, cursor: last.cursor }, last)])).toThrow("cursor")
  expect(() => parseTurnFrames([ndjson({ type: "accepted", cursor: start }, last, first)])).toThrow()
  expect(() => parseTurnFrames([ndjson({ type: "accepted", cursor: start }, { ...first, batch: { ...first.batch, frames: [{ ...delta, text: 1 }] } }, last)])).toThrow()
  // Unknown raw frame fields must not be silently stripped before core verification.
  expect(() => parseTurnFrames([ndjson({ type: "accepted", cursor: start }, { ...first, batch: { ...first.batch, frames: [{ ...delta, uncommitted: "bytes" }] } }, last)])).toThrow()
  expect(() => parseTurnFrames([body + "malformed\n"])).toThrow()
  expect(() => parseTurnFrames([body + ndjson(first)])).toThrow()
})

test("legacy delivery is available only with explicit mode and still needs valid terminal evidence", () => {
  const body = ndjson(delta, done)
  expect(() => parseTurnFrames([body])).toThrow()
  expect(parseTurnFrames([body], { protocol: "legacy" })).toEqual([delta, done])
  expect(() => parseTurnFrames([ndjson(delta)], { protocol: "legacy" })).toThrow("terminal frame")
  expect(() => parseTurnFrames([ndjson({ type: "done" })], { protocol: "legacy" })).toThrow()
  expect(() => parseTurnFrames([ndjson(done, delta)], { protocol: "legacy" })).toThrow()
})

test("network capture requires the actual advertised journal version, with explicit legacy opt-in", () => {
  expect(() => assertTurnTrafficProtocol({ "X-Smithers-Turn-Journal": "1" }, "journal-v1")).not.toThrow()
  for (const headers of [{}, { "x-smithers-turn-journal": "2" }, { "x-smithers-turn-journal": 1 }]) {
    expect(() => assertTurnTrafficProtocol(headers, "journal-v1")).toThrow()
  }
  expect(() => assertTurnTrafficProtocol({}, "legacy")).not.toThrow()
  expect(() => assertTurnTrafficProtocol({ "x-smithers-turn-journal": "1" }, "legacy")).toThrow()
})
