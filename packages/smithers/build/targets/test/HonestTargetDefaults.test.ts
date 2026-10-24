import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"

const withDefault = (value: unknown) =>
  Target.make("ConstructorDefault", {
    attrs: Schema.Struct({ data: Schema.Unknown.pipe(Schema.withConstructorDefault(Effect.succeed(value))) }),
    kinds: ["build"],
    cache: false,
    implementation: () => Node.succeed(undefined)
  })

it.each([
  () => new Date(0),
  () => Object.assign([Input.file("visible")], { extra: Input.file("extra") }),
  () => Object.assign([Input.file("visible")], { [Symbol("extra")]: true }),
  () => Object.setPrototypeOf([Input.file("visible")], null),
  () => {
    const array = Array(2)
    array[1] = Input.file("later")
    return array
  },
  () => Object.defineProperty([Input.file("hidden")], "0", { enumerable: false }),
  () => ({ [Symbol("opaque")]: true, file: Input.file("not-walked") }),
  () => Object.defineProperty({}, "hidden", { value: Input.file("hidden"), enumerable: false })
])("does not discover inputs by traversing an unadmitted default container", (create) => {
  const target = withDefault(create())({})
  expect(Target.metadata(target).inputs).toEqual([])
})

it.each(["record", "array"] as const)(
  "rejects a %s accessor produced by an Effect constructor default without invoking it",
  (kind) => {
    let invoked = false
    const value = Object.defineProperty(kind === "array" ? [0] : {}, kind === "array" ? "0" : "field", {
      enumerable: true,
      configurable: true,
      get: () => {
        invoked = true
        return Input.file("secret")
      }
    })
    expect(() => withDefault(value)({})).toThrow(/accessor|data property/)
    expect(invoked).toBe(false)
  }
)

it("rejects a proxy returned by a constructor default without invoking its traps", () => {
  let invoked = false
  const value = new Proxy({}, {
    get: () => {
      invoked = true
      return undefined
    }
  })
  expect(() => withDefault(value)({})).toThrow(/Proxy/)
  expect(invoked).toBe(false)
})

it("applies a schema default when a raw attribute is non-enumerable", () => {
  const attrs = Object.defineProperty({}, "data", { value: "hidden", enumerable: false })
  const target = withDefault("fallback")(attrs)
  expect(Target.metadata(target).attrs).toEqual({ data: "fallback" })
})

it("rejects accessors nested in an explicit attribute before decoding them", () => {
  let invoked = false
  const value = Object.defineProperty({}, "field", {
    enumerable: true,
    get: () => {
      invoked = true
      return 1
    }
  })
  expect(() => withDefault(null)({ data: value })).toThrow(/accessor|data property/)
  expect(invoked).toBe(false)
})

it("suggests a declaration key even when the typo differs only in case", () => {
  const rule = Target.make("CaseSensitive", {
    attrs: Schema.Struct({ data: Schema.String }),
    kinds: ["build"],
    implementation: () => Node.succeed(undefined)
  })
  expect(() => rule({ DATA: "value" } as never)).toThrow(/did you mean "data"/)
})

it("bounds guidance for a declaration with many unknown keys", () => {
  const rule = Target.make("UnknownKeys", {
    attrs: Schema.Struct({ known: Schema.String }),
    kinds: ["build"],
    implementation: () => Node.succeed(undefined)
  })
  let error: unknown
  try {
    rule({ known: "value", ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => ["unknown" + i, i])) } as never)
  } catch (cause) {
    error = cause
  }
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain("unknown property")
  expect((error as Error).message.length).toBeLessThan(10_000)
})

it("refuses a runtime declaration with a non-function implementation", () => {
  expect(() =>
    Target.make("InvalidImplementation", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      implementation: 42 as never
    })
  ).toThrow(/function/)
})
