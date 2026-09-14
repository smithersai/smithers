import { describe, expect, test } from "vitest"
import {
  NATIVE_CODE_PREFIX,
  NATIVE_FAILURES,
  NATIVE_ROUTE_CODES,
  nativeFailureCode,
  nativeFailureStatus,
  nativeWireCode
} from "../src/NativeFailureCodes.ts"
import type { NativeRouteCode } from "../src/NativeFailureCodes.ts"
import { PLUE_FAILURE_CODES, PLUE_FAILURES } from "../src/PlueFailureCodes.ts"
import type { PlueFault } from "../src/PlueFailureCodes.ts"
import {
  faultOfStatus,
  isNativeFailureCode,
  isWorkerFailureCode,
  mayAutoRetry,
  nativeRefusal,
  refusalCode,
  refusalEntry,
  refusalFromStored,
  refusalOf,
  storedRefusal
} from "../src/Refusal.ts"
import { agentFaultNote, agentRefusalText, refusalLead } from "../src/RefusalCopy.ts"
import { WORKER_FAILURE_CODES, WORKER_FAILURES } from "../src/WorkerFailureCodes.ts"

/*
 * The desktop app's own host (apps/app/src/bun) is the THIRD party that
 * refuses. plue's registry is generated and vendored, the Worker's is written
 * by hand beside it, and this one is written for the routes only the native
 * host serves. These are the properties that keep the three from colliding,
 * from drifting apart in shape, or from telling a reader that a laptop with no
 * Node on it is Smithers running out of infra.
 */
describe("the native host's own failure registry", () => {
  test("shares no code with plue's or the Worker's, which is what lets one string name its author", () => {
    const wire = NATIVE_ROUTE_CODES.map(nativeWireCode)
    expect(wire.filter((code) => Object.hasOwn(PLUE_FAILURES, code))).toEqual([])
    expect(wire.filter((code) => Object.hasOwn(WORKER_FAILURES, code))).toEqual([])
  })

  /*
   * The namespace, not the spelling, is what holds. plue's list is refreshed
   * from its own artifact (102 codes and counting) and the Worker's grows by
   * hand; this fails the moment either one spends a `native_` name, which is
   * the only way a collision could still happen.
   */
  test("reserves its namespace: no code of plue's or the Worker's may wear the prefix", () => {
    expect(PLUE_FAILURE_CODES.filter((code) => code.startsWith(NATIVE_CODE_PREFIX))).toEqual([])
    expect(WORKER_FAILURE_CODES.filter((code) => code.startsWith(NATIVE_CODE_PREFIX))).toEqual([])
  })

  /*
   * Why the prefix exists at all, stated as a test rather than only in prose:
   * these route names ARE plue's and the Worker's spellings, and they do not
   * all mean the same thing — plue's `not_implemented` is a `bug`, this host's
   * is a build that does not carry a seam.
   */
  test("names the collisions it was written for, so the prefix is not mistaken for decoration", () => {
    const collisions = NATIVE_ROUTE_CODES.filter((code) =>
      Object.hasOwn(PLUE_FAILURES, code) || Object.hasOwn(WORKER_FAILURES, code)
    )
    expect(collisions).toEqual([
      "internal",
      "invalid_json",
      "invalid_path",
      "invalid_request",
      "language_server_missing",
      "method_not_allowed",
      "not_found",
      "not_implemented",
      "unsupported_media_type"
    ])
    expect(PLUE_FAILURES.not_implemented.fault).toBe("bug")
    expect(NATIVE_FAILURES.not_implemented.fault).toBe("user")
  })

  test("stays sorted and free of duplicates, so a new code lands in one obvious place", () => {
    expect([...NATIVE_ROUTE_CODES]).toEqual([...new Set(NATIVE_ROUTE_CODES)].sort())
  })

  test("answers the same three questions per row as plue's and the Worker's", () => {
    for (const code of NATIVE_ROUTE_CODES) {
      const entry = NATIVE_FAILURES[code]
      expect(Object.keys(entry).sort()).toEqual(["fault", "retryAfter", "status"])
      expect(entry.status).toBeGreaterThanOrEqual(400)
      expect(entry.retryAfter).toBeGreaterThanOrEqual(0)
      expect(nativeFailureStatus(code)).toBe(entry.status)
    }
  })

  /*
   * There is no fleet inside a program on the reader's own box, and `infra`'s
   * copy is entirely about ours being full. A row here that claimed it would
   * tell someone whose laptop has no Node on it to yell at @fucory for more
   * infra.
   */
  test("never claims Smithers' own infra failed, because none of it is ours to run out of", () => {
    /*
     * Read through the declared fault type, not the literal union `satisfies`
     * infers from the rows. Against the inferred union TS calls `=== "infra"`
     * a comparison with no overlap and fails the build (TS2367) — the table
     * proving the invariant at compile time is exactly what stopped the
     * runtime check from compiling. Widening keeps both: the types say no row
     * is infra, and this still catches a row that reaches the map some other
     * way.
     */
    const faultOf = (code: NativeRouteCode): PlueFault => NATIVE_FAILURES[code].fault
    expect(NATIVE_ROUTE_CODES.filter((code) => faultOf(code) === "infra")).toEqual([])
    for (const code of NATIVE_ROUTE_CODES) {
      const refusal = nativeRefusal(code, "x")
      expect(refusalLead(refusal)).not.toContain("@fucory")
      expect(refusalLead(refusal)).not.toContain("ran out")
      expect(agentRefusalText(refusal)).not.toContain("@fucory")
      /* Nor a deployment: nobody deployed the app on the reader's own box. */
      expect(refusalLead(refusal)).not.toContain("deployment")
    }
  })

  test("reads a code back to its own table and never to plue's", () => {
    for (const code of NATIVE_ROUTE_CODES) {
      const wire = nativeWireCode(code)
      expect(nativeFailureCode(wire)).toBe(wire)
      expect(refusalCode(wire)).toBe(wire)
      expect(isNativeFailureCode(wire)).toBe(true)
      expect(isWorkerFailureCode(wire)).toBe(false)
      expect(refusalEntry(wire)).toEqual(NATIVE_FAILURES[code])
    }
    /* The BARE name on the wire is still plue's, which is the whole point. */
    expect(nativeFailureCode("not_found")).toBeNull()
    expect(refusalCode("not_found")).toBe("not_found")
    expect(nativeFailureCode("native_nothing_like_this")).toBeNull()
  })
})

describe("a native-host refusal as it reaches the app", () => {
  test("carries the host's code, its documented fault, and origin=local", () => {
    for (const code of NATIVE_ROUTE_CODES) {
      const entry = NATIVE_FAILURES[code]
      const refusal = refusalOf({
        body: { status: "error", code: nativeWireCode(code), origin: "local" },
        status: entry.status,
        message: "nope"
      })
      expect(refusal.code).toBe(nativeWireCode(code))
      expect(refusal.fault).toBe(entry.fault)
      expect(refusal.origin).toBe("local")
    }
  })

  /*
   * The host's envelope carries the code even when the answer says nothing
   * about who wrote it — a card read back from storage, say — because the
   * namespace alone identifies the author.
   */
  test("is local by its code alone, with no origin stated", () => {
    expect(refusalOf({ body: { code: "native_repo_not_found" }, status: 404, message: "x" }).origin).toBe("local")
    expect(refusalFromStored({ status: 404, message: "x", code: "native_repo_not_found" }).origin).toBe("local")
  })

  test("is built the same way on both sides: nativeRefusal takes status and fault from the table", () => {
    for (const code of NATIVE_ROUTE_CODES) {
      const entry = NATIVE_FAILURES[code]
      const built = nativeRefusal(code, "nope")
      expect(built.status).toBe(entry.status)
      expect(built.fault).toBe(entry.fault)
      expect(built).toEqual(
        refusalOf({
          body: { status: "error", code: nativeWireCode(code), origin: "local" },
          status: entry.status,
          message: "nope"
        })
      )
    }
  })

  test("survives a round trip through a card's stored shape", () => {
    const refusal = nativeRefusal("node_missing", "No Node.js >= 22.19 was found for the smithers-build CLI.")
    expect(refusalFromStored(storedRefusal(refusal))).toEqual(refusal)
  })

  /*
   * Every one of these used to be classified by status alone. The two that
   * changed the reader's answer most: a 503 for a missing program guessed
   * `infra` (our fleet), and a 501 for a seam this build does not carry
   * guessed `bug` (Smithers is broken).
   */
  test("beats the status guess it used to get", () => {
    expect(faultOfStatus(503)).toBe("infra")
    expect(nativeRefusal("node_missing", "x").fault).toBe("dependency")
    expect(faultOfStatus(501)).toBe("bug")
    expect(nativeRefusal("not_implemented", "x").fault).toBe("user")
  })

  test("is never retried on a timer unless the host said to wait and said how long", () => {
    for (const code of NATIVE_ROUTE_CODES) {
      const refusal = nativeRefusal(code, "x")
      expect(mayAutoRetry(refusal)).toBe(NATIVE_FAILURES[code].fault === "wait" && refusal.retryAfter !== null)
    }
  })

  test("tells the chat model the fault class for a native code too, through the string channel", () => {
    const note = agentFaultNote("native_node_missing — No Node.js >= 22.19 was found for the smithers-build CLI.")
    expect(note).toContain("[fault=dependency code=native_node_missing]")
    expect(note).not.toContain("@fucory")
    expect(agentFaultNote("native_nothing_like_this — x")).toBeNull()
  })
})
