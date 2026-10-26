import assert from "node:assert/strict"
import { test } from "node:test"
import { count, type HostRecord, keyOf, report, row } from "./stats.ts"

const record = (overrides: Partial<HostRecord>): HostRecord => ({
  host: "a",
  devices: 2,
  signedIn: false,
  startedAt: "2026-10-26T16:00:00.000Z",
  endedAt: "2026-10-26T16:01:00.000Z",
  routes: 2,
  responses: {},
  unanswered: 0,
  upToDateMs: [100, 200, 300, 400],
  writeToDeviceMs: [],
  ...overrides,
})

test("responses are counted by status and whether they were live", () => {
  const counts: Record<string, number> = {}
  for (const response of [{ status: 200, live: true }, { status: 200, live: true }, { status: 503, live: false }]) count(counts, response)
  assert.deepEqual(counts, { "200 live": 2, "503 initial": 1 })
  assert.equal(keyOf({ status: 429, live: false }), "429 initial")
})

test("hosts' records sum into one report over the run's whole window, and a clean run passes", () => {
  const r = report([
    record({ responses: { "200 initial": 50, "200 live": 10 } }),
    record({ host: "b", endedAt: "2026-10-26T16:02:00.000Z", responses: { "200 initial": 60 } }),
  ])
  assert.equal(r.devices, 4)
  assert.equal(r.seconds, 120)
  assert.equal(r.requests, 120)
  assert.equal(r.requestsPerSecond, 1)
  assert.deepEqual(r.upToDate, { p50: 250, p99: 400, max: 400, over10s: 0, never: 0 })
  assert.equal(r.writeToAllDevices, null)
  assert.equal(r.pass, true)
  assert.match(row("8 signed out", r), /^\| 8 signed out \| 4 \| 120 \| 120 \| 1 \| 0 \(0\) \| 0 \| 0 \| 250 \/ 400 \| 0 \| pass \|$/)
})

test("any 5xx, 429, unanswered request or route not up to date within 10 s fails the run, and each is counted", () => {
  const failing = [
    record({ responses: { "500 initial": 1 } }),
    record({ responses: { "503 live": 2 } }),
    record({ responses: { "429 initial": 1 } }),
    record({ unanswered: 1 }),
    record({ upToDateMs: [100, 10_001] }),
    record({ upToDateMs: [100, null] }),
  ]
  for (const one of failing) assert.equal(report([one]).pass, false)
  const r = report(failing)
  assert.equal(r.status5xx, 3)
  assert.equal(r.status503, 2)
  assert.equal(r.status429, 1)
  assert.equal(r.unanswered, 1)
  assert.equal(r.upToDate.over10s, 1)
  assert.equal(r.upToDate.never, 1)
  assert.match(row("x", r), /\| fail \|$/)
})

test("write-to-all-devices is the spread of each device's first change after the write; a device without one is missed", () => {
  const r = report([record({ writeToDeviceMs: [1_000, 3_000, null] }), record({ writeToDeviceMs: [2_000] })])
  assert.deepEqual(r.writeToAllDevices, { p50: 2_000, p99: 2_980, missed: 1 })
})

test("a run where no route got up to date reports no times, and fails", () => {
  const r = report([record({ upToDateMs: [null, null] })])
  assert.deepEqual(r.upToDate, { p50: null, p99: null, max: null, over10s: 0, never: 2 })
  assert.equal(r.pass, false)
  assert.match(row("x", r), /\| - \/ - \| 2 \| fail \|$/)
})
