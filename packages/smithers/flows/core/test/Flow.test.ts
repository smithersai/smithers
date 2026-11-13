import { Flow as Durable } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as Annotations from "../src/Annotations.ts"
import * as Flow from "../src/Flow.ts"
import * as Markdown from "../src/Markdown.ts"
import * as Placement from "../src/Placement.ts"
describe("Flow combinators", () => {
  const original = Markdown.lowerMarkdown({
    name: "core/original",
    description: "the declaration every combinator rebuilds",
    capabilities: ["net"],
    model: "smart",
    flows: ["helper"]
  }, "P")

  it("returns fresh values and leaves the original alone", () => {
    const placed = original.pipe(Flow.within(Placement.sandbox({ profile: "test" })))

    for (const variant of [placed]) {
      expect(variant).not.toBe(original)
      expect(variant.name).toBe("core/original")
      expect(variant.description).toBe("the declaration every combinator rebuilds")
      expect(variant.model).toBe("smart")
      expect(variant.flows).toEqual(["helper"])
      expect(variant.prompt).toBe("P")
      expect(variant.flow._tag).toBe("core/original")
    }
    expect(original.capabilities).toEqual(["net"])
    expect(original.effects).toBeUndefined()
    expect(Option.isNone(Annotations.getOption(original.annotations, Annotations.Placement))).toBe(true)
    expect(Option.getOrUndefined(Annotations.getOption(placed.annotations, Annotations.Placement))).toEqual(
      Placement.sandbox({ profile: "test" })
    )
  })

  it("snapshots markdown collaborators and model seats before decoration", () => {
    const flows = ["helper"]
    const model: [string, ...Array<string>] = ["smart", "fast"]
    const lowered = Markdown.lowerMarkdown({ name: "snapshot", flows, model }, "P")
    const placed = Flow.within(lowered, Placement.sandbox())

    flows.push("late-helper")
    model[0] = "changed"
    model.push("late-seat")

    for (const signature of [lowered, placed, Flow.withFlows(lowered, ["replacement"])]) {
      expect(signature.model).toEqual(["smart", "fast"])
    }
    expect(lowered.flows).toEqual(["helper"])
    expect(placed.flows).toEqual(["helper"])
  })

  it("attaches a typed annotation without disturbing the declared ones", () => {
    const Bank = Context.Service<{ readonly bank: string }>("test/Flow/Bank")
    const direct = Flow.annotate(original, Bank, { bank: "one" })
    const piped = original.pipe(Flow.annotate(Bank, { bank: "two" }))

    expect(Option.isNone(Annotations.getOption(original.annotations, Bank))).toBe(true)
    expect(Option.getOrUndefined(Annotations.getOption(direct.annotations, Bank))).toEqual({ bank: "one" })
    expect(Option.getOrUndefined(Annotations.getOption(piped.annotations, Bank))).toEqual({ bank: "two" })
    // The declared capability ceiling survives the rebuild.
    expect(Option.getOrUndefined(Context.getOption(direct.annotations, Durable.Capabilities))).toEqual(["net"])
  })

  it("replaces the collaborators a signature declares and snapshots the replacement", () => {
    const replacements: Array<Flow.Reference> = ["replacement"]
    const rebound = Flow.withFlows(original, replacements)

    replacements.push("late")

    expect(rebound.flows).toEqual(["replacement"])
    expect(original.flows).toEqual(["helper"])
    expect(rebound.capabilities).toEqual(["net"])
    expect(rebound.prompt).toBe("P")
  })
})

it("retains annotation overrides on lowered signatures", () => {
  const base = Markdown.lowerMarkdown({ name: "frozen" }, "Prompt")
  const narrowed = Flow.annotate(base, Durable.Capabilities, [])
  expect(narrowed.capabilities).toEqual([])
  const envelope = { reads: [], writes: [], mode: "hermetic", onConflict: "fail", tier: "sealed" } as const
  const overridden = Flow.annotate(base, Annotations.Effects, envelope)
  expect(overridden.effects).toEqual(envelope)
  expect(overridden.action?.tier).toBe("sealed")
  expect(base.action?.tier).toBe("irreversible")
  expect(Flow.isFlow(base)).toBe(true)
  expect(Flow.isFlow(undefined)).toBe(false)
})
