import { Smithers as S } from "@smthrs/targets"
import { describe, expect, it } from "vitest"
import { collectTargets } from "../src/internal/Attrs.ts"

describe("declaration attr inspection", () => {
  const first = S.Filegroup({ srcs: [] })
  const second = S.Filegroup({ srcs: [] })

  it("ignores class instances even when they contain a target", () => {
    class Container {
      readonly target = first
    }
    expect(collectTargets(new Container())).toEqual([])
  })

  it("reads data descriptors without evaluating getters", () => {
    const attrs = Object.defineProperty({ data: first }, "accessor", {
      get: () => {
        throw new Error("inspection evaluated a getter")
      }
    })
    expect(collectTargets(attrs)).toEqual([first])
  })

  it("tolerates an own key whose descriptor disappears during inspection", () => {
    const attrs = new Proxy({}, {
      ownKeys: () => ["removed"],
      getOwnPropertyDescriptor: () => undefined
    })
    expect(collectTargets(attrs)).toEqual([])
  })

  it("bounds cycles and retains repeated target encounters in order", () => {
    const attrs: Record<string, unknown> = Object.create(null)
    attrs["targets"] = [first, second, first]
    attrs["self"] = attrs
    expect(collectTargets(attrs)).toEqual([first, second, first])
  })
})
