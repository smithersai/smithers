import { describe, expect, expectTypeOf, it } from "vitest"
import { failureMessage } from "./failure-message.ts"
import { WeakEtagError } from "./remote-state.ts"

describe("failureMessage", () => {
  it("renders a plain error message", () => {
    expect(failureMessage(new Error("state directory is read-only"))).toBe("state directory is read-only")
  })

  it.each([
    { key: "alchemy/Test.json", etag: 'W/"e1"' },
    { key: "alchemy/Nested Stack.json", etag: 'W/"version-2"' }
  ])("renders an immutable weak ETag diagnostic for $key", ({ key, etag }) => {
    const error = new WeakEtagError({ key, etag })
    const message = `R2 state ${key} carries the weak ETag ${etag}, which R2 never matches on a conditional write`

    expectTypeOf<Pick<WeakEtagError, "message">>().toEqualTypeOf<{ readonly message: string }>()
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: "WeakEtagError", _tag: "@smthrs/build-infra/WeakEtagError", key, etag })
    expect(failureMessage(error)).toBe(message)
    expect(Object.getOwnPropertyDescriptor(error, "message")).toEqual({
      value: message,
      writable: false,
      enumerable: false,
      configurable: false
    })
    expect(Reflect.set(error, "message", "hidden")).toBe(false)
    expect(failureMessage(error)).toBe(message)
  })

  it("does not render anything that is not an error", () => {
    expect(failureMessage("a thrown string")).toBe("unrenderable failure")
    expect(failureMessage(undefined)).toBe("unrenderable failure")
  })

  it("does not run a message accessor on the way to the terminal", () => {
    let reads = 0
    const hostile = Object.defineProperty(new Error("hidden"), "message", {
      get: () => {
        reads += 1
        return "computed"
      }
    })

    expect(failureMessage(hostile)).toBe("unrenderable failure")
    expect(reads).toBe(0)
  })

  it("survives a failure that throws when it is inspected", () => {
    const revocable = Proxy.revocable(new Error("revoked"), {})
    revocable.revoke()

    expect(failureMessage(revocable.proxy)).toBe("unrenderable failure")
  })
})
