// A Durable Object failure is described by a known class, Cloudflare's flags and a message category, never its text,
// and describing any thrown value never throws (worker/DurableObjectFailure.ts).
import { describe as group, expect, test } from "vitest"
import { categoryOf, classOf, describe, KNOWN_CLASSES } from "./DurableObjectFailure.ts"

/** What workerd rejects I/O with in an instance Cloudflare has replaced (smithers.sh, 2026-11-02 13:32:41Z). */
export const inactive = () =>
  Object.assign(
    new Error("Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request."),
    { retryable: true },
  )

/** Values a handler can throw that break naive property reads. */
export const hostileValues = (): ReadonlyArray<unknown> => [
  Object.create(null),
  new Proxy({}, {
    get: () => {
      throw new Error("getter")
    },
    getPrototypeOf: () => {
      throw new Error("prototype")
    },
  }),
  Object.defineProperty(new Error("x"), "message", {
    get: () => {
      throw new Error("message")
    },
  }),
  42,
  "text",
  undefined,
  null,
]

group("categoryOf", () => {
  test("names Cloudflare's Durable Object failures by a fixed category, never by their text", () => {
    expect(categoryOf(new Error("Network connection lost."))).toBe("connection-lost")
    expect(categoryOf(new Error("Durable Object reset because its code was updated."))).toBe("reset")
    expect(categoryOf(inactive())).toBe("instance-inactive")
    expect(categoryOf(new Error("Durable Object is overloaded. Requests queued for too long."))).toBe("overloaded")
    expect(categoryOf(new Error("Durable Object's isolate exceeded its memory limit and was reset."))).toBe("memory-limit")
    expect(categoryOf(new Error("Durable Object exceeded its CPU time limit and was reset."))).toBe("cpu-limit")
    expect(categoryOf(new Error("Durable Object storage operation exceeded timeout which caused object to be reset."))).toBe(
      "storage-timeout",
    )
    expect(categoryOf(new Error("internal error; reference = abc123"))).toBe("internal")
    expect(categoryOf(new Error("person@example.com"))).toBe("other")
    expect(categoryOf("Network connection lost.")).toBe("other")
  })
})

group("classOf", () => {
  test("names a known class or tag, and anything else, a tag built from content included, unknown", () => {
    expect(classOf(new TypeError("x"))).toBe("TypeError")
    expect(classOf({ _tag: "RpcCallError" })).toBe("RpcCallError")
    expect(classOf(Object.assign(new Error("x"), { _tag: "private-user@example.test" }))).toBe("unknown")
    expect(classOf(new (class PersonAlice extends Error {})("x"))).toBe("unknown")
    expect([...KNOWN_CLASSES].every((name) => /^[A-Za-z]+$/.test(name))).toBe(true)
  })
})

group("describe", () => {
  test("any thrown value is described without throwing", () => {
    // The Error whose message getter throws is still an Error; every other value has no known class.
    for (const [n, value] of hostileValues().entries()) {
      expect(describe(value)).toEqual({
        errorTag: n === 2 ? "Error" : "unknown",
        category: "other",
        retryable: false,
        overloaded: false,
        remote: false,
      })
    }
    expect(describe(inactive())).toEqual({
      errorTag: "Error",
      category: "instance-inactive",
      retryable: true,
      overloaded: false,
      remote: false,
    })
  })
})
