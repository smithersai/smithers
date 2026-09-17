import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Classifiers from "../src/Classifiers.ts"

const fieldDescriptions = (schema: Schema.Top): ReadonlyArray<string> => {
  const document = Schema.toJsonSchemaDocument(schema).schema as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>
  }
  return Object.values(document.properties).map((field) => field.description ?? "")
}

describe("the curated classifiers", () => {
  it("ship the three the design names, in catalog order, with distinct digests", () => {
    expect(Classifiers.all.map((classifier) => classifier.id)).toEqual([
      "triage/relevance",
      "check/verdict",
      "edit/risk"
    ])
    expect(new Set(Classifiers.all.map((classifier) => classifier.digest)).size).toBe(3)
  })

  it("ask the questions the design names, one atomic judgment each", () => {
    expect(Object.keys(Classifiers.relevance.questions)).toEqual(["relevant", "role", "risk"])
    expect(Classifiers.relevance.questions.role.criteria).toEqual({
      implementation: expect.any(String),
      fixture: expect.any(String),
      unrelated: expect.any(String)
    })
    expect(Classifiers.relevance.questions.risk.criteria).toEqual(["none", "low", "medium", "high"])
    expect(Object.keys(Classifiers.checkVerdict.questions)).toEqual(["rightReason", "invalidProbe"])
    expect(Object.keys(Classifiers.editRisk.questions)).toEqual(["risk", "reversible"])
    expect(Classifiers.editRisk.questions.risk.criteria).toEqual(["none", "low", "medium", "high"])
    for (const classifier of Classifiers.all) {
      for (const question of Object.values(classifier.questions)) {
        expect(question.instructions).toMatch(/^[A-Z].*\?$/)
        expect(question.instructions).not.toContain(" and ")
        if (question.type === "boolean") expect(question.criteria).toBeDefined()
      }
    }
  })

  it("describe every state field and the classifier itself in one sentence", () => {
    for (const classifier of Classifiers.all) {
      expect(classifier.description.trim().endsWith(".")).toBe(true)
      expect(classifier.description.split(". ")).toHaveLength(1)
      const descriptions = fieldDescriptions(classifier.state)
      expect(descriptions.length, classifier.id).toBeGreaterThan(0)
      for (const description of descriptions) expect(description, classifier.id).not.toBe("")
    }
    expect(Object.keys((Classifiers.relevance.state as Schema.Struct<Schema.Struct.Fields>).fields)).toEqual([
      "task",
      "file",
      "excerpt"
    ])
    expect(Object.keys((Classifiers.checkVerdict.state as Schema.Struct<Schema.Struct.Fields>).fields)).toEqual([
      "command",
      "exitCode",
      "output"
    ])
    expect(Object.keys((Classifiers.editRisk.state as Schema.Struct<Schema.Struct.Fields>).fields)).toEqual([
      "path",
      "hunk",
      "task"
    ])
  })

  it("evaluate a scripted transport into typed answers", async () => {
    const layer = Evaluator.layerScripted((request) => {
      const ids = Object.keys(request.questions)
      return Object.fromEntries(ids.map((id) => {
        const question = request.questions[id]!
        return [
          id,
          question.type === "boolean"
            ? { probability: 0.9 }
            : question.type === "choice"
            ? { choice: Object.keys(question.criteria)[0]! }
            : { score: question.criteria.length - 1 }
        ]
      }))
    })
    const verdict = await Effect.runPromise(
      Classifiers.checkVerdict.evaluate({ command: "pytest -q", exitCode: 1, output: "AssertionError" }).pipe(
        Effect.provide(layer)
      )
    )
    expect(verdict.rightReason.value).toBe(true)
    expect(verdict.invalidProbe.probability).toBe(0.9)
    const risk = await Effect.runPromise(
      Classifiers.editRisk.evaluate({ path: "a.py", hunk: "-a\n+b", task: "rename" }).pipe(Effect.provide(layer))
    )
    expect(risk.risk.label).toBe("high")
    expect(risk.reversible.value).toBe(true)
    const relevance = await Effect.runPromise(
      Classifiers.relevance.evaluate({ task: "t", file: "f", excerpt: "e" }).pipe(Effect.provide(layer))
    )
    expect(relevance.role.value).toBe("implementation")
  })
})
