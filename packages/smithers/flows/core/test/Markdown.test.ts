import { Flow as Durable, Graph } from "@smthrs/flow"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { describe, expect, it } from "vitest"
import * as Annotations from "../src/Annotations.ts"
import * as Effects from "../src/Effects.ts"
import * as Flow from "../src/Flow.ts"

import * as Markdown from "../src/Markdown.ts"
import * as Placement from "../src/Placement.ts"

describe("Markdown", () => {
  it("lowers markdown to an ordinary signature tagged with its name", () => {
    const flow = Markdown.lowerMarkdown({ name: "summarize" }, "Summarize the supplied arguments.")

    expect(flow.name).toBe("summarize")
    expect(flow.flow._tag).toBe("summarize")
    expect(flow.action?.name).toBe("summarize")
    expect(flow.effects).toBeUndefined()
    // The authored call splices the one-call flow, which calls the action.
    expect(Graph.nodes(Graph.build(flow.call({ args: "hello" }))).map((node) => node.kind)).toEqual([
      "ActionCall",
      "FlowCall"
    ])
  })

  it("forwards the markdown body as the prompt and applies the documented defaults", () => {
    const flow = Markdown.lowerMarkdown({ name: "prompted" }, "The markdown prompt.")

    expect(flow.prompt).toBe("The markdown prompt.")
    expect(flow.model).toBe("smart")
    expect(flow.flows).toEqual([])
  })

  it("normalizes capability and effect declarations", () => {
    const flow = Markdown.lowerMarkdown({
      name: "normalized",
      capabilities: ["shell", "shell", "git"],
      effects: {
        reads: ["src", "src"],
        writes: ["dist", "dist"],
        mode: "expected",
        onConflict: "lane"
      }
    }, "Prompt")

    expect(flow.capabilities).toEqual(["git", "shell"])
    expect(flow.effects).toEqual(Effects.make({
      reads: ["src", "src"],
      writes: ["dist", "dist"],
      mode: "expected",
      onConflict: "lane"
    }))
  })

  // A caller granting `fs` and `net` to the lowered flow: the planned graph
  // shows whether the flow's own ceiling joins the caller's.
  const grantedTo = (callee: ReturnType<typeof Markdown.lowerMarkdown>) =>
    Graph.nodes(Graph.build(
      Durable.make("granting", {
        payload: Schema.Struct({ args: Schema.String }),
        success: Schema.String,
        capabilities: ["fs", "net"],
        body: ({ args }) => callee.call({ args })
      }).call({ args: "hello" })
    )).map((node) => node.capabilityCeilings)

  it("keeps an explicit empty capability list as the ceiling that denies every capability", () => {
    const denied = Markdown.lowerMarkdown({ name: "denied", capabilities: [] }, "Prompt")

    expect(denied.capabilities).toEqual([])
    for (const bag of [denied.annotations, denied.flow.annotations, denied.action!.annotations]) {
      expect(Option.getOrUndefined(Annotations.getOption(bag, Durable.Capabilities))).toEqual([])
    }
    // The action and the lowered flow carry the empty group beside the
    // caller's grant; the granting flow's own node keeps only its grant.
    expect(grantedTo(denied)).toEqual([
      [["fs", "net"], [], []],
      [["fs", "net"], []],
      [["fs", "net"]]
    ])
  })

  it("leaves the capability ceiling to the caller when the frontmatter declares none", () => {
    const inherited = Markdown.lowerMarkdown({ name: "inherited" }, "Prompt")

    expect(inherited.capabilities).toEqual([])
    for (const bag of [inherited.annotations, inherited.flow.annotations, inherited.action!.annotations]) {
      expect(bag.mapUnsafe.has(Durable.Capabilities.key)).toBe(false)
    }
    expect(grantedTo(inherited)).toEqual([[["fs", "net"]], [["fs", "net"]], [["fs", "net"]]])
  })

  it.each([undefined, []] as const)("retains the %j capability declaration through decorators", (capabilities) => {
    const original = Markdown.lowerMarkdown({ name: "decorated", capabilities }, "Prompt")
    const decorated = Flow.withFlows(Flow.within(original, Placement.sandbox()), ["helper"])

    expect(grantedTo(decorated)).toEqual(grantedTo(original))
    expect(decorated.flow.annotations.mapUnsafe.has(Durable.Capabilities.key)).toBe(capabilities !== undefined)
    expect(decorated.action!.annotations.mapUnsafe.has(Durable.Capabilities.key)).toBe(capabilities !== undefined)
  })

  it.each(
    (["hermetic", "expected"] as const).flatMap((mode) =>
      (["serialize", "lane", "fail"] as const).flatMap((onConflict) =>
        (["sealed", "compensable", "irreversible"] as const).map((tier) => ({ mode, onConflict, tier }))
      )
    )
  )("preserves valid effect enums $mode/$onConflict/$tier", (effects) => {
    const lowered = Markdown.lowerMarkdown({ name: "effects", effects }, "Prompt")

    expect(lowered.effects).toMatchObject(effects)
    expect(lowered.action!.tier).toBe(effects.tier)
  })

  it("uses the empty read set when markdown effects omit reads", () => {
    const flow = Markdown.lowerMarkdown({ name: "empty-reads", effects: {} }, "Prompt")

    expect(flow.effects).toMatchObject({ reads: [], writes: [] })
  })

  it.each(
    [
      ["sandbox", Placement.sandbox()],
      ["remote", Placement.remote()],
      ["client", Placement.client()],
      ["local", Placement.local()]
    ] as const
  )("places the lowered flow with the %s annotation", (placement, expected) => {
    const flow = Markdown.lowerMarkdown({ name: `placed-${placement}`, placement }, "Prompt")

    expect(Option.getOrThrow(Annotations.getOption(flow.annotations, Annotations.Placement))).toEqual(expected)
  })

  it.each([
    ["an unknown placement", { placement: "moon" }, /"refused" placement is invalid/],
    ["an unknown effect mode", { effects: { mode: "loose" } }, /"refused" effects is invalid/],
    ["an unknown conflict strategy", { effects: { onConflict: "race" } }, /"refused" effects is invalid/],
    ["an unknown effect tier", { effects: { tier: "bogus" } }, /"refused" effects is invalid/],
    ["a non-string write path", { effects: { writes: [7] } }, /"refused" effects is invalid/]
  ])("refuses %s instead of lowering it", (_label, fields, message) => {
    const lower = () => Markdown.lowerMarkdown({ name: "refused", ...fields } as never, "Prompt")
    expect(lower).toThrow(RangeError)
    expect(lower).toThrow(message)
  })

  it("accepts exactly the Agent Skills name grammar", () => {
    for (const name of ["pdf", "pdf-processing", "a1-b2", "x".repeat(64)]) expect(Markdown.isSkillName(name)).toBe(true)
    for (const name of ["", "-pdf", "pdf-", "pdf--x", "PDF", "p_df", "x".repeat(65)]) {
      expect(Markdown.isSkillName(name)).toBe(false)
    }
  })

  it("returns a stable code when SKILL.md frontmatter is incomplete", () => {
    const result = Markdown.parseSkill("---\nname: example\n---\n")

    expect(Result.isFailure(result) && result.failure.code).toBe("skill_missing_description")
  })

  it("keeps untyped skill extras out of lowering and uses the smart default seat", () => {
    const flow = Result.getOrThrow(Markdown.lowerSkill(
      "---\nname: example\ndescription: Example skill\nmodel: fast\nplacement: remote\n---\nPrompt"
    ))

    // lowerSkill's JSDoc keeps untyped extras at the parse boundary, so
    // lowerMarkdown supplies its documented default.
    expect(flow.model).toBe("smart")
    expect(flow.name).toBe("example")
    expect(Option.isNone(Annotations.getOption(flow.annotations, Annotations.Placement))).toBe(true)
  })
})
