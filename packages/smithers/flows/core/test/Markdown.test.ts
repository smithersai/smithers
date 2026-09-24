import { Graph } from "@smthrs/flow"
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

  it("has the same structure as an equivalent hand-written signature", () => {
    const markdown = Markdown.lowerMarkdown({
      name: "markdown-flow",
      description: "A markdown flow",
      model: "small",
      flows: ["search"],
      capabilities: ["network"],
      effects: { reads: ["docs"] }
    }, "Prompt")
    const handwritten = Flow.make({
      name: "markdown-flow",
      description: "A markdown flow",
      input: Schema.Struct({ args: Schema.String }),
      output: Schema.String,
      capabilities: ["network"],
      effects: Effects.make({
        reads: ["docs"],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize"
      }),
      model: "small",
      flows: ["search"],
      prompt: "Prompt"
    })

    expect(Graph.nodes(Graph.build(markdown.flow, { args: "" })).map((node) => node.kind)).toEqual(
      Graph.nodes(Graph.build(handwritten.flow, { args: "" })).map((node) => node.kind)
    )
    expect(markdown.action?.tier).toBe(handwritten.action?.tier)
    expect(markdown.capabilities).toEqual(handwritten.capabilities)
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
