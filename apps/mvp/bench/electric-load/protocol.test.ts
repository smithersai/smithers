import assert from "node:assert/strict"
import { test } from "node:test"
import { backoffMs, START, step, urlOf } from "./protocol.ts"

const headers = (values: Record<string, string>) => new Headers(values)

test("a device asks from offset -1, catches up on the handle and offset each answer names, then long-polls with the cursor", () => {
  assert.equal(urlOf("https://x.test", "/api/shapes/items", { repo: "a/b" }, START), "https://x.test/api/shapes/items?repo=a%2Fb&offset=-1")
  const first = step(START, 200, headers({ "electric-handle": "h1", "electric-offset": "0_10" }), "[]")
  assert.deepEqual(first, { next: { handle: "h1", offset: "0_10", live: false, failures: 0 }, waitMs: 0, upToDate: false, changed: false })
  const caughtUp = step(first.next, 200, headers({ "electric-handle": "h1", "electric-offset": "0_20", "electric-up-to-date": "", "electric-cursor": "c1" }), '[{"headers":{"operation":"insert"}}]')
  assert.equal(caughtUp.upToDate, true)
  assert.equal(caughtUp.changed, true)
  assert.equal(urlOf("https://x.test", "/api/shapes/items", {}, caughtUp.next), "https://x.test/api/shapes/items?offset=0_20&handle=h1&live=true&cursor=c1")
  const quiet = step(caughtUp.next, 200, headers({ "electric-up-to-date": "" }), '[{"headers":{"control":"up-to-date"}}]')
  assert.deepEqual(quiet.next, caughtUp.next)
  assert.equal(quiet.changed, false)
})

test("a 409 starts the shape over on the handle it names, sending the expired one", () => {
  const moved = step({ handle: "h1", offset: "0_20", live: true, cursor: "c", failures: 0 }, 409, headers({ "electric-handle": "h2" }), "")
  assert.deepEqual(moved.next, { offset: "-1", live: false, failures: 0, handle: "h2", expiredHandle: "h1" })
  assert.equal(urlOf("https://x.test", "/s", {}, moved.next), "https://x.test/s?offset=-1&handle=h2&expired_handle=h1")
  assert.deepEqual(step(START, 409, headers({}), "").next, START)
})

test("a 5xx, 429 or no answer waits the default policy's backoff, or retry-after when longer, and keeps its place", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(backoffMs), [1_000, 2_000, 4_000, 8_000, 10_000, 10_000])
  const at = { handle: "h", offset: "1", live: true, failures: 0 }
  const overloaded = step(at, 503, headers({ "retry-after": "5" }), "")
  assert.deepEqual(overloaded, { next: { ...at, failures: 1 }, waitMs: 5_000, upToDate: false, changed: false })
  assert.equal(step(overloaded.next, 500, headers({}), "", 1.2).waitMs, 2_400)
  assert.equal(step({ ...at, failures: 4 }, 429, headers({ "retry-after": "nonsense" }), "").waitMs, 10_000)
  assert.equal(step(at, undefined, headers({}), "", 0.8).waitMs, 800)
})

test("another 4xx waits the longest backoff without moving", () => {
  assert.deepEqual(step(START, 401, headers({}), ""), { next: { ...START, failures: 1 }, waitMs: 10_000, upToDate: false, changed: false })
})
