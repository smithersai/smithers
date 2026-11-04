import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { defaultResearch, main, run } from "../../examples/11-agent-step.vibe"

/** The research fields as the writing step's prompt renders them. */
const handedTo = (prompt: string, keyPointCount: number) => ({
  summary: prompt.split("Summary: ")[1]?.split("\n")[0] ?? "",
  keyPoints: (prompt.split("Key points:\n")[1]?.split("\n") ?? []).slice(0, keyPointCount)
})

it.effect("chains two model-backed steps and returns the schema-typed article", () =>
  Effect.gen(function*() {
    const handoff = yield* main

    expect(handoff.article.article).toBe(
      "Durable workflows survive restarts because their steps are recorded, not remembered."
    )
    expect(handoff.article.wordCount).toBe(12)

    // The writing step ran once, and it was handed the research step's decoded
    // fields: the summary and every key point, in the prompt fields `Write`
    // declares. The article above cannot show this, because the scripted model
    // selects it from the instruction, which an empty handoff still carries.
    expect(handoff.writerPrompts).toHaveLength(1)
    expect(handedTo(handoff.writerPrompts[0]!, defaultResearch.keyPoints.length)).toEqual({
      summary: defaultResearch.summary,
      keyPoints: defaultResearch.keyPoints.map((point) => `- ${point}`)
    })
  }))

it.effect("hands the writing step whatever the research step returned", () =>
  Effect.gen(function*() {
    const research = {
      summary: "Replay reconstructs a run from its records instead of its memory.",
      keyPoints: ["records outlive the process", "a resumed step is not re-run", "the plan is the budget"]
    }
    const handoff = yield* run(research, "agent-step-distinct")

    // A second, different research answer reaches the writer unchanged, so the
    // transfer is the research step's values and not a constant in the example.
    expect(handoff.writerPrompts).toHaveLength(1)
    expect(handedTo(handoff.writerPrompts[0]!, research.keyPoints.length)).toEqual({
      summary: research.summary,
      keyPoints: research.keyPoints.map((point) => `- ${point}`)
    })
  }))
