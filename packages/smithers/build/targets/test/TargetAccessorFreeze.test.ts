import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Target from "../src/Target.ts"

describe("declaration-owned accessor freezing", () => {
  it("freezes an accessor added by the definition inputs hook without reading it", () => {
    let reads = 0
    const getter = () => {
      reads++
      throw new Error("the freeze traversal must not run an accessor")
    }
    const make = Target.make("AccessorAttrsProbe", {
      attrs: Schema.Struct({ value: Schema.String }),
      kinds: ["test"],
      inputs: (attrs) => {
        Object.defineProperty(attrs, "computed", { enumerable: true, configurable: true, get: getter })
        return []
      },
      implementation: Target.catalogNotImplemented
    })
    const attrs = Target.metadata(make({ value: "plain" })).attrs
    expect(reads).toBe(0)
    expect(Object.isFrozen(attrs)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(attrs, "computed")).toMatchObject({
      get: getter,
      configurable: false
    })
  })

  it("freezes accessor-bearing default annotation documents without replacing their descriptor", () => {
    let reads = 0
    const annotation = {
      get x() {
        reads++
        return 1
      }
    }
    const getter = Object.getOwnPropertyDescriptor(annotation, "x")?.get
    expect(getter).toBeTypeOf("function")
    const make = Target.make("AccessorAnnotationProbe", {
      attrs: Schema.Struct({ value: Schema.Struct({ x: Schema.Number }).annotate({ default: annotation }) }),
      kinds: ["test"],
      implementation: Target.catalogNotImplemented
    })
    expect(reads).toBeGreaterThan(0)
    expect(Object.isFrozen(annotation)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(annotation, "x")).toMatchObject({
      get: getter,
      configurable: false
    })
    expect(Target.metadata(make({ value: { x: 2 } })).target).toBe("AccessorAnnotationProbe")
  })
})
