import { afterAll, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExtractAnythingWorkbench, layer } from "../../../examples/use-cases/extract-anything-workbench.ts"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "extract-anything-workbench-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const input = { text: "Order 77 ships to Lisbon" }
const targetSchema = { type: "object", required: ["orderId", "city"] }

/**
 * Extractors whose confidence is `confidence[name]` (an extractor missing from
 * it answers off-schema), a validator that passes a candidate when every
 * required key of the schema it was handed is present, and a reviewer that
 * picks the valid candidate with the highest confidence among those it was
 * handed. Requests are recorded in order.
 */
const script = (confidence: Readonly<Record<string, number>>) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const extract = /Extract with the "(.+)" extractor\.\n\nTarget schema: (.+)\nInput: (.+)/.exec(asked)
    if (extract !== null) {
      const name = extract[1]!
      const { text } = JSON.parse(extract[3]!)
      turns.push(`extract ${name}`)
      const score = confidence[name]
      if (score === undefined) return { unexpected: true }
      // The weaker extractor misses the city.
      const fields = [{ key: "orderId", value: /Order (\d+)/.exec(text)![1]!, confidence: score }]
      if (score > 0.5) fields.push({ key: "city", value: /to (\w+)/.exec(text)![1]!, confidence: score })
      return { extractorName: name, fields, rawOutput: text, overallConfidence: score }
    }
    const validate = /Validate this candidate\.\n\nTarget schema: (.+)\nCandidate: (.+)/.exec(asked)
    if (validate !== null) {
      const { required } = JSON.parse(validate[1]!)
      const candidate = JSON.parse(validate[2]!)
      const keys: Array<string> = candidate.fields.map((f: { key: string }) => f.key)
      const missing: Array<string> = required.filter((key: string) => !keys.includes(key))
      turns.push(`validate ${candidate.extractorName}`)
      return {
        extractorName: candidate.extractorName,
        isValid: missing.length === 0,
        errors: missing.map((key) => `missing ${key}`),
        warnings: [],
        fieldCount: keys.length,
        confidenceScore: candidate.overallConfidence
      }
    }
    const preview = /Pick the best extractor\.\n\nInput: .+\nValidations: (.+)\nCandidates: (.+)/.exec(asked)
    if (preview !== null) {
      const validations: Array<{ extractorName: string; isValid: boolean; confidenceScore: number }> = JSON.parse(
        preview[1]!
      )
      const candidates: Array<{ extractorName: string; fields: Array<{ key: string; value: string }> }> = JSON.parse(
        preview[2]!
      )
      turns.push(`preview ${validations.map((v) => v.extractorName).join(",")}`)
      const best = validations.filter((v) => v.isValid).sort((a, b) => b.confidenceScore - a.confidenceScore)[0]
      const chosen = candidates.find((c) => c.extractorName === best?.extractorName)
      return {
        selectedExtractor: best?.extractorName ?? null,
        extractedData: chosen === undefined ? null : Object.fromEntries(chosen.fields.map((f) => [f.key, f.value])),
        summary: `${validations.length} candidates compared`,
        recommendation: best === undefined ? "discard" : "use"
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("extracts with every candidate, validates them all, then picks the best", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ regex: 0.4, llm: 0.9 })
    const preview = yield* Kit.run(ExtractAnythingWorkbench, { input, targetSchema, extractors: ["regex", "llm"] }, {
      filename: join(directory, "two.sqlite"),
      executionId: "workbench-two",
      script: answer,
      actions: layer
    })

    // Every extraction finished before any validation, and every validation before the preview.
    expect(turns.slice(0, 2).sort()).toEqual(["extract llm", "extract regex"])
    expect(turns.slice(2, 4).sort()).toEqual(["validate llm", "validate regex"])
    // The reviewer was handed both validations in the order the extractors were named.
    expect(turns[4]).toBe("preview regex,llm")
    expect(preview).toEqual({
      selectedExtractor: "llm",
      extractedData: { orderId: "77", city: "Lisbon" },
      summary: "2 candidates compared",
      recommendation: "use"
    })
  }))

it.effect("runs the single auto extractor when none are named", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ auto: 0.3 })
    const preview = yield* Kit.run(ExtractAnythingWorkbench, { input, targetSchema }, {
      filename: join(directory, "auto.sqlite"),
      executionId: "workbench-auto",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual(["extract auto", "validate auto", "preview auto"])
    // Its candidate missed a required field, so there is nothing to adopt.
    expect(preview).toEqual({
      selectedExtractor: null,
      extractedData: null,
      summary: "1 candidates compared",
      recommendation: "discard"
    })
  }))

it.effect("fails without validating when an extractor fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ llm: 0.9 })
    const exit = yield* Effect.exit(
      Kit.run(ExtractAnythingWorkbench, { input, targetSchema, extractors: ["broken", "llm"] }, {
        filename: join(directory, "broken.sqlite"),
        executionId: "workbench-broken",
        script: answer,
        actions: layer
      })
    )

    expect(Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined).toMatchObject({
      _tag: "Some",
      value: { _tag: "/harness/StructuredOutputFailure" }
    })
    expect(turns).toContain("extract broken")
    expect(turns.some((turn) => turn.startsWith("validate") || turn.startsWith("preview"))).toBe(false)
  }))
