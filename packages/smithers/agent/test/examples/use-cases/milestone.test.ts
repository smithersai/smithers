import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, Milestone } from "../../../examples/use-cases/milestone.vibe"

const directory = mkdtempSync(join(tmpdir(), "milestone-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * An implementer that reports `status[id]` (default `complete`) with the
 * summary `built <id>`, and a validator that fails the milestones in
 * `failing`. Every request is recorded in order: an implement turn lists the
 * completed milestones it was told about, a validate turn the command it was
 * handed.
 */
const script = (
  options: { readonly failing?: ReadonlyArray<string>; readonly status?: Record<string, string> } = {}
) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const implement = /Implement milestone ".+" \((.+)\):/.exec(asked)
    if (implement !== null) {
      const id = implement[1]!
      const told = [...asked.matchAll(/^- (\S+): built \S+$/gm)].map((match) => match[1])
      turns.push(`implement ${id} after [${told.join(", ")}]`)
      return {
        milestone: id,
        status: options.status?.[id] ?? "complete",
        filesChanged: [`src/${id}.ts`],
        summary: `built ${id}`
      }
    }
    const validate = /Validate milestone ".+" \((.+)\):\nValidation command: (.+)/.exec(asked)
    if (validate !== null) {
      const id = validate[1]!
      const passed = !(options.failing ?? []).includes(id)
      turns.push(`validate ${id} with ${validate[2]}`)
      return {
        milestone: id,
        passed,
        // The check is named, not quoted: a validator in this offline kit has
        // no tools, and the completion brake refuses an answer that names a
        // command its own session never ran.
        checks: [passed ? { name: `${id} checks`, passed } : { name: `${id} checks`, passed, error: "3 type errors" }]
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("works the default milestones in order when every validation passes", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const progress = yield* Kit.run(Milestone, { directory: "app" }, {
      filename: join(directory, "all-pass.sqlite"),
      executionId: "milestone-all-pass",
      script: answer,
      actions: layer
    })

    // Each implementer ran after the previous validation and was told what
    // the earlier implementers completed; each validator ran its own command.
    expect(turns).toEqual([
      "implement m0 after []",
      "validate m0 with npx tsc --noEmit",
      "implement m1 after [m0]",
      "validate m1 with npm test",
      "implement m2 after [m0, m1]",
      "validate m2 with npm run build"
    ])
    expect(progress).toEqual({
      currentMilestone: "complete",
      completedMilestones: ["m0", "m1", "m2"],
      remainingMilestones: [],
      overallProgress: 100,
      summary: "3/3 milestones complete (100%)"
    })
  }))

it.effect("stops at the first milestone whose validation fails", () =>
  Effect.gen(function*() {
    const spec = (id: string) => ({
      id,
      title: `the ${id}`,
      requirements: `build the ${id}`,
      validation: `pnpm test ${id}`
    })
    const milestones = [spec("schema"), spec("api"), spec("ui")] as const
    // The schema implementer reports failure, but its validation passes: the
    // gate is the validator, and the next implementer is told of no completed
    // milestone because none reported complete.
    const { answer, turns } = script({ failing: ["api"], status: { schema: "failed" } })
    const progress = yield* Kit.run(Milestone, { directory: "app", milestones }, {
      filename: join(directory, "api-fails.sqlite"),
      executionId: "milestone-api-fails",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      "implement schema after []",
      "validate schema with pnpm test schema",
      "implement api after []",
      "validate api with pnpm test api"
    ])
    expect(progress).toEqual({
      currentMilestone: "api",
      completedMilestones: ["schema"],
      remainingMilestones: ["api", "ui"],
      overallProgress: 33,
      summary: "1/3 milestones complete (33%)"
    })
  }))

it.effect("reports no progress when the first validation fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ failing: ["m0"] })
    const progress = yield* Kit.run(Milestone, { directory: "app" }, {
      filename: join(directory, "first-fails.sqlite"),
      executionId: "milestone-first-fails",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual(["implement m0 after []", "validate m0 with npx tsc --noEmit"])
    expect(progress).toEqual({
      currentMilestone: "m0",
      completedMilestones: [],
      remainingMilestones: ["m0", "m1", "m2"],
      overallProgress: 0,
      summary: "0/3 milestones complete (0%)"
    })
  }))
