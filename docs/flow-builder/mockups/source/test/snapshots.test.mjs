import assert from "node:assert/strict"
import { test } from "node:test"

import { NODE_BY_ID, REKEYED } from "../src/flow.ts"
import { buildFrames, FRAMES } from "../src/script.ts"

const frame = (label) => {
  const found = FRAMES.find((item) => item.label === label)
  assert.ok(found, label)
  return found
}

test("retry snapshots retain only evidence observed by that frame", () => {
  const running = frame("Running the suite").evidence.test
  const failed = frame("Attempt 1 fails").evidence.test
  const retry = frame("Retry").evidence.test
  const second = frame("Attempt 2").evidence.test
  const settled = frame("Parked on you").evidence.test

  assert.deepEqual(running.attempts, [{ attempt: 1, state: "running" }])
  assert.deepEqual(running.journal.map((row) => row.type), [
    "flows.engine.node-scheduled", "flows.engine.attempt-started"
  ])
  assert.equal(failed.attempts[0].state, "failed")
  assert.equal(failed.attempts[0].ms, 61_000)
  assert.match(failed.attempts[0].error, /cold cache/)
  assert.deepEqual(retry, failed)
  assert.deepEqual(second.attempts, [failed.attempts[0], { attempt: 2, state: "running" }])
  assert.deepEqual(settled.attempts, [
    failed.attempts[0], { attempt: 2, state: "succeeded", ms: 64_000 }
  ])
  assert.equal(settled.attempts.reduce((sum, row) => sum + row.ms, 0), NODE_BY_ID.test.ms)
  assert.match(settled.journal.at(-1).payload, /outcome: "built", attempts: 2/)

  for (const [earlier, later] of [[running, failed], [failed, second], [second, settled]]) {
    assert.deepEqual(later.journal.slice(0, earlier.journal.length), earlier.journal)
  }
  assert.equal(Object.keys(frame("Ready").evidence).length, 0)
  assert.deepEqual(buildFrames(), FRAMES, "rebuilding the demo must not mutate earlier snapshots")
})

test("every attempt and settlement agrees with its frame and current run", () => {
  const rerunStart = FRAMES.findIndex((item) => item.label.startsWith("Cache hit"))
  for (const [index, snapshot] of FRAMES.entries()) {
    for (const [id, evidence] of Object.entries(snapshot.evidence)) {
      const where = `${snapshot.label}: ${id}`
      assert.deepEqual(evidence.journal.map((row) => row.seq), evidence.journal.map((_, i) => i + 1), where)
      assert.equal(evidence.journal[0].type, "flows.engine.node-scheduled", where)
      for (const [i, attempt] of evidence.attempts.entries()) {
        assert.equal(attempt.attempt, i + 1, where)
        assert.ok(evidence.journal.some((row) => row.type === "flows.engine.attempt-started" && row.payload.includes(`attempt: ${attempt.attempt} }`)), where)
        if (attempt.state === "running") {
          assert.equal(attempt.ms, undefined, where)
          assert.equal(attempt.error, undefined, where)
          assert.equal(i, evidence.attempts.length - 1, where)
        } else {
          assert.equal(typeof attempt.ms, "number", where)
          assert.ok(attempt.ms >= 0, where)
          assert.ok(evidence.journal.some((row) => row.type === "flows.engine.attempt-finished" && row.payload.includes(`attempt: ${attempt.attempt}, state: "${attempt.state}"`)), where)
        }
      }
      const last = evidence.journal.at(-1)
      if (last.type === "flows.engine.node-settled") {
        assert.match(last.payload, new RegExp(`attempts: ${evidence.attempts.length},`), where)
        if (index >= rerunStart && snapshot.nodes[id] === "clean") {
          assert.equal(evidence.attempts.length, 0, where)
          assert.match(last.payload, /outcome: "clean"/, where)
        } else {
          assert.equal(evidence.attempts.at(-1).state, "succeeded", where)
        }
      }
      if (index >= rerunStart) {
        const expectedKey = REKEYED.includes(id) ? NODE_BY_ID[id].rekey : NODE_BY_ID[id].key
        assert.ok(evidence.journal[0].payload.includes(expectedKey), where)
      }
    }
  }
})
