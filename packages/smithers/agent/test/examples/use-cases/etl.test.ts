import { afterAll, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Etl, layer } from "../../../examples/use-cases/etl.ts"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "etl-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * An extractor that reads `count` records, a transformer that upper-cases the
 * records it is shown (or answers off-schema when `brokenTransform`), and a
 * loader that loads the records it is shown. Each request is recorded in order
 * with the records it carried and its trailing count line.
 */
const script = (count: number, brokenTransform = false) => {
  const turns: Array<string> = []
  const prompts: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a data extractor")) {
      prompts.push(asked)
      turns.push("extract")
      const records = Array.from(
        { length: count },
        (_, i) => ({ id: `r${i + 1}`, raw: `row ${i + 1}`, source: "a.csv" })
      )
      return { records, totalExtracted: count }
    }
    const transform = /Transform these (\d+) records:\n\n(.+)\n(.*)\n/.exec(asked)
    if (transform !== null) {
      prompts.push(asked)
      const shown: Array<{ id: string; raw: string }> = JSON.parse(transform[2]!)
      turns.push(`transform ${shown.map((r) => r.id).join(",")} ${transform[3]}`.trim())
      if (brokenTransform) return { unexpected: true }
      return {
        records: shown.map((r) => ({ id: r.id, transformed: r.raw.toUpperCase(), metadata: { from: "a.csv" } })),
        totalTransformed: Number(transform[1]),
        errors: []
      }
    }
    const load = /Load (\d+) transformed records to: (.+)\n\nRecords:\n(.+)\n(.*)\n/.exec(asked)
    if (load !== null) {
      prompts.push(asked)
      const shown: Array<{ id: string; transformed: string }> = JSON.parse(load[3]!)
      turns.push(`load ${shown.map((r) => r.transformed).join(",")} ${load[4]}`.trim())
      return {
        totalLoaded: Number(load[1]),
        destination: load[2]!,
        errors: [],
        summary: `loaded ${shown.length} shown records`
      }
    }
    return undefined
  }
  return { answer, prompts, turns }
}

it.effect("shows each later stage the first five records and counts the rest", () =>
  Effect.gen(function*() {
    const { answer, prompts, turns } = script(7)
    const loaded = yield* Kit.run(Etl, {
      source: "data/a.csv",
      destination: "postgres://warehouse/rows",
      transformRules: "Upper-case every row",
      onDuplicate: "overwrite"
    }, {
      filename: join(directory, "seven.sqlite"),
      executionId: "etl-seven",
      script: answer,
      actions: layer
    })

    // Each stage ran after the one before, on the records that stage produced.
    expect(turns).toEqual([
      "extract",
      "transform r1,r2,r3,r4,r5 ... and 2 more",
      "load ROW 1,ROW 2,ROW 3,ROW 4,ROW 5 ... and 2 more"
    ])
    expect(prompts[0]).toContain("Extract data from: data/a.csv\nPattern: *\nFormat: auto-detect")
    expect(prompts[1]).toContain("Transformation rules:\nUpper-case every row\n\nOutput format: JSON")
    expect(prompts[2]).toContain("Handle duplicates: overwrite")
    expect(loaded).toEqual({
      totalLoaded: 7,
      destination: "postgres://warehouse/rows",
      errors: [],
      summary: "loaded 5 shown records"
    })
  }))

it.effect("adds no count line when every record fits the prompt", () =>
  Effect.gen(function*() {
    const { answer, prompts, turns } = script(2)
    const loaded = yield* Kit.run(Etl, { source: "data/b.csv", destination: "s3://bucket/out" }, {
      filename: join(directory, "two.sqlite"),
      executionId: "etl-two",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual(["extract", "transform r1,r2", "load ROW 1,ROW 2"])
    expect(prompts[1]).toContain("Transformation rules:\nNormalize and clean the data")
    expect(prompts[2]).toContain("Handle duplicates: skip")
    expect(loaded.totalLoaded).toBe(2)
  }))

it.effect("stops before loading when the transform fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(3, true)
    const exit = yield* Effect.exit(Kit.run(Etl, { source: "data/c.csv", destination: "s3://bucket/out" }, {
      filename: join(directory, "broken.sqlite"),
      executionId: "etl-broken",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined).toMatchObject({
      _tag: "Some",
      value: { _tag: "/harness/StructuredOutputFailure" }
    })
    expect(turns).toContain("transform r1,r2,r3")
    expect(turns.some((turn) => turn.startsWith("load"))).toBe(false)
  }))
