import { Context, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Annotations from "../src/Annotations.ts"
import * as Placement from "../src/Placement.ts"

describe("Annotations", () => {
  it("adds annotations immutably", () => {
    const annotated = Annotations.add(Annotations.empty, Annotations.Placement, Placement.local())

    expect(annotated).not.toBe(Annotations.empty)
    expect(Option.isNone(Annotations.getOption(Annotations.empty, Annotations.Placement))).toBe(true)
    expect(Annotations.getOption(annotated, Annotations.Placement)).toEqual(Option.some(Placement.local()))
  })

  it("merges immutably with child-over-parent precedence", () => {
    const parent = Annotations.add(Annotations.empty, Annotations.Placement, Placement.local())
    const child = Annotations.add(Annotations.empty, Annotations.Placement, Placement.sandbox({ image: "ubuntu-22" }))
    const merged = Annotations.merge(parent, child)

    expect(merged).not.toBe(parent)
    expect(merged).not.toBe(child)
    expect(Annotations.getOption(parent, Annotations.Placement)).toEqual(Option.some(Placement.local()))
    expect(Annotations.getOption(child, Annotations.Placement)).toEqual(
      Option.some(Placement.sandbox({ image: "ubuntu-22" }))
    )
    expect(Annotations.getOption(merged, Annotations.Placement)).toEqual(
      Option.some(Placement.sandbox({ image: "ubuntu-22" }))
    )
  })

  it("returns Option values for annotation hits and misses", () => {
    const Other = Context.Service<string>("flows/core/test/Other")
    const context = Annotations.add(Annotations.empty, Annotations.Priority, 7)

    expect(Annotations.getOption(context, Annotations.Priority)).toEqual(Option.some(7))
    expect(Annotations.getOption(context, Other)).toEqual(Option.none())
  })
})
