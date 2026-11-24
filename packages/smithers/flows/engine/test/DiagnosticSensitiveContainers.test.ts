import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { vi } from "vitest"
import { hostReflection, renderDiagnosticWith } from "../src/internal/Diagnostic.ts"

const renderDiagnostic = (value: unknown) => renderDiagnosticWith(hostReflection(process), value)

it("redacts sensitive fields before traversing object and array values", () => {
  const secret = "sensitive-container-XYZ123"
  const value = { token: { value: secret }, password: [secret], apiKey: { message: secret } }
  expect(renderDiagnostic(value)).not.toContain(secret)
  expect(JSON.parse(renderDiagnostic(value))).toEqual({
    token: "[REDACTED]",
    password: "[REDACTED]",
    apiKey: "[REDACTED]"
  })
})

it("never traverses a proxy stored under a sensitive field", () => {
  let calls = 0
  const secret = new Proxy({}, {
    getOwnPropertyDescriptor: () => {
      calls++
      throw new Error("private")
    }
  })
  expect(renderDiagnostic({ token: secret })).toBe("{\"token\":\"[REDACTED]\"}")
  expect(calls).toBe(0)
})

it("never runs a proxy's traps, at the top or nested", () => {
  let calls = 0
  const trap = new Proxy({}, {
    getOwnPropertyDescriptor: () => {
      calls++
      return undefined
    }
  })
  expect(renderDiagnostic(trap)).toBe("[proxy]")
  expect(renderDiagnostic({ message: "failed", cause: trap })).toBe(
    JSON.stringify({ message: "failed", cause: "[proxy]" })
  )
  expect(calls).toBe(0)
})

/** A value that counts every way reading it could run caller code. */
const counting = () => {
  const calls = { getter: 0, tag: 0, trap: 0 }
  const accessors = Object.defineProperties({}, {
    message: {
      enumerable: true,
      get: () => {
        calls.getter++
        return "from a getter"
      }
    },
    [Symbol.toStringTag]: {
      get: () => {
        calls.tag++
        return "Error"
      }
    }
  })
  const count = () => {
    calls.trap++
    throw new Error("secret-from-trap")
  }
  const proxy = new Proxy({ message: "target" }, {
    get: count,
    has: count,
    ownKeys: count,
    getOwnPropertyDescriptor: count,
    getPrototypeOf: count
  })
  const array = new Proxy(["target"], { get: count, getOwnPropertyDescriptor: count, ownKeys: count })
  return { calls, values: [accessors, proxy, array, { message: "failed", cause: proxy }, [accessors, proxy]] }
}

it("reads nothing off any object when the host offers no proxy test", () => {
  const { calls, values } = counting()
  for (const value of values) expect(renderDiagnosticWith(undefined, value)).toBe("[uninspected]")
  expect(calls).toEqual({ getter: 0, tag: 0, trap: 0 })
  // Primitives carry no code, so they render as on any host.
  expect(renderDiagnosticWith(undefined, "token=abc")).toBe("token=[REDACTED]")
  expect(renderDiagnosticWith(undefined, "plain text")).toBe("plain text")
  expect(renderDiagnosticWith(undefined, 7)).toBe("7")
  expect(renderDiagnosticWith(undefined, null)).toBe("null")
})

it("runs no accessor or trap with the host's own proxy test", () => {
  const { calls, values } = counting()
  expect(values.map(renderDiagnostic)).toEqual([
    "[object]",
    "[proxy]",
    "[proxy]",
    JSON.stringify({ message: "failed", cause: "[proxy]" }),
    JSON.stringify(["[object]", "[proxy]"])
  ])
  expect(calls).toEqual({ getter: 0, tag: 0, trap: 0 })
})

it("renders the constant fallback when the injected proxy test itself fails", () => {
  const faulty = {
    isProxy: () => {
      throw new Error("secret-from-reflection")
    }
  }
  expect(renderDiagnosticWith(faulty, { message: "failed" })).toBe("[unrenderable]")
  expect(renderDiagnosticWith(faulty, "failed")).toBe("failed")
})

it("takes a host's reflection only when it is a working predicate", () => {
  const rejecting = {
    getBuiltinModule: (id: string) => {
      throw new Error(`no builtin ${id}`)
    }
  }
  expect(hostReflection(undefined)).toBeUndefined()
  expect(hostReflection({})).toBeUndefined()
  expect(hostReflection({ getBuiltinModule: undefined })).toBeUndefined()
  expect(hostReflection(rejecting)).toBeUndefined()
  expect(hostReflection({ getBuiltinModule: () => undefined })).toBeUndefined()
  expect(hostReflection({ getBuiltinModule: () => ({ types: {} }) })).toBeUndefined()
  expect(hostReflection({ getBuiltinModule: () => ({ types: { isProxy: "yes" } }) })).toBeUndefined()
  const asked: Array<string> = []
  const reflection = hostReflection({
    getBuiltinModule: (id) => {
      asked.push(id)
      return { types: { isProxy: () => true } }
    }
  })
  expect(asked).toEqual(["node:util"])
  expect(renderDiagnosticWith(reflection, { message: "plain" })).toBe("[proxy]")
})

it.each([
  ["absent", undefined],
  ["rejecting", () => {
    throw new Error("no builtins on this host")
  }]
])("imports the engine and renders inertly under an %s builtin lookup", async (_name, lookup) => {
  const getBuiltinModule = process.getBuiltinModule
  vi.resetModules()
  Object.defineProperty(process, "getBuiltinModule", { value: lookup, configurable: true, writable: true })
  try {
    const engine = await import("../src/index.ts")
    const { renderDiagnostic: render } = await import("../src/internal/Diagnostic.ts")
    expect(engine.FlowProxyServer.FlowHandlerDefect).toBeDefined()
    const { calls, values } = counting()
    const rendered = await Effect.runPromise(Effect.forEach(values, render))
    expect(rendered).toEqual(values.map(() => "[uninspected]"))
    expect(calls).toEqual({ getter: 0, tag: 0, trap: 0 })
  } finally {
    Object.defineProperty(process, "getBuiltinModule", { value: getBuiltinModule, configurable: true, writable: true })
    vi.resetModules()
  }
})

it("renders under the reflection its context provides", async () => {
  const { CurrentReflection, renderDiagnostic: render } = await import("../src/internal/Diagnostic.ts")
  const value = { message: "failed" }
  expect(await Effect.runPromise(render(value))).toBe(JSON.stringify(value))
  expect(await Effect.runPromise(render(value).pipe(Effect.provideService(CurrentReflection, undefined))))
    .toBe("[uninspected]")
  expect(
    await Effect.runPromise(render(value).pipe(Effect.provideService(CurrentReflection, { isProxy: () => true })))
  ).toBe("[proxy]")
})
