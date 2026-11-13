import { describe, expect, test } from "vitest"
import { PLUE_FAILURE_CODES, PLUE_FAILURES } from "../src/PlueFailureCodes.ts"
import {
  faultOfStatus,
  isWorkerFailureCode,
  mayAutoRetry,
  refusalCode,
  refusalEntry,
  refusalFromStored,
  refusalOf,
  storedRefusal
} from "../src/Refusal.ts"
import { WORKER_FAILURE_CODES, WORKER_FAILURES, workerFailureCode } from "../src/WorkerFailureCodes.ts"
import { workerRefusal } from "./refusalFixtures.ts"

/*
 * The Cloudflare Worker's own refusals. plue's registry is generated and
 * vendored; this one is written by hand, and these are the properties that
 * keep the two from colliding, from drifting apart in shape, or from reaching
 * a person with a sentence nobody wrote for them.
 */
describe("the Worker's own failure registry", () => {
  test("shares no code with plue's, which is what lets one string name its author", async () => {
    const shared = WORKER_FAILURE_CODES.filter((code) => Object.hasOwn(PLUE_FAILURES, code))
    expect(shared).toEqual([])
  })

  test("stays sorted and free of duplicates, so a new code lands in one obvious place", async () => {
    expect([...WORKER_FAILURE_CODES]).toEqual([...new Set(WORKER_FAILURE_CODES)].sort())
  })

  test("answers the same three questions per row as plue's", async () => {
    const shape = Object.keys(WORKER_FAILURES[WORKER_FAILURE_CODES[0]]).sort()
    expect(shape).toEqual(["fault", "retryAfter", "status"])
    for (const code of PLUE_FAILURE_CODES) {
      expect(Object.keys(PLUE_FAILURES[code]).sort(), code).toEqual(shape)
    }
    for (const code of WORKER_FAILURE_CODES) {
      const entry = WORKER_FAILURES[code]
      expect(Object.keys(entry).sort(), code).toEqual(shape)
      expect(entry.status).toBeGreaterThanOrEqual(400)
      expect(entry.retryAfter).toBeGreaterThanOrEqual(0)
    }
  })

  test("reads a code back to its own table and never to plue's", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      expect(workerFailureCode(code)).toBe(code)
      expect(refusalCode(code)).toBe(code)
      expect(isWorkerFailureCode(code)).toBe(true)
      expect(refusalEntry(code)).toEqual(WORKER_FAILURES[code])
    }
    expect(workerFailureCode("no_capacity")).toBeNull()
    expect(isWorkerFailureCode("no_capacity")).toBe(false)
  })
})

describe("a Worker refusal as it reaches the app", () => {
  test("carries the Worker's own code, its documented fault, and origin=worker", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      const entry = WORKER_FAILURES[code]
      const refusal = refusalOf({ body: { status: "error", code }, status: entry.status, message: "nope" })
      expect(refusal.code).toBe(code)
      expect(refusal.rawCode).toBe(code)
      expect(refusal.fault).toBe(entry.fault)
      expect(refusal.origin).toBe("worker")
    }
  })

  test("decodes the registry status and pacing from an HTTP response", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      const entry = WORKER_FAILURES[code]
      const paced = entry.retryAfter > 0
      const built = await workerRefusal(code, "nope")
      expect({ status: built.status, fault: built.fault, origin: built.origin, retryAfter: built.retryAfter }).toEqual({
        status: entry.status,
        fault: entry.fault,
        origin: "worker",
        retryAfter: paced ? entry.retryAfter : null
      })
    }
  })

  test("the desktop host's envelope says local and carries the same pacing", async () => {
    const refusal = await workerRefusal("model_rate_limited", "slow down", { origin: "local" })
    expect({ origin: refusal.origin, retryAfter: refusal.retryAfter }).toEqual({ origin: "local", retryAfter: 60 })
  })

  test("survives a round trip through a card's stored shape", async () => {
    const refusal = await workerRefusal("deployment_not_configured", "CEREBRAS_API_KEY is unset.")
    expect(refusalFromStored(storedRefusal(refusal))).toEqual(refusal)
  })

  test("beats the status guess it used to get: a 501 is infra here, not the bug faultOfStatus reads", async () => {
    expect(faultOfStatus(501)).toBe("bug")
    expect((await workerRefusal("deployment_not_configured", "x")).fault).toBe("infra")
  })

  test("is never retried on a timer unless the Worker said to wait and said how long", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      const refusal = await workerRefusal(code, "x")
      expect(mayAutoRetry(refusal)).toBe(WORKER_FAILURES[code].fault === "wait" && refusal.retryAfter !== null)
    }
  })
})
